import nodeFs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { claudeProjectDirSlug, resolveClaudeProjectsRoots } from '../services/claude-session-root-service.mjs';

// Keep a resumable Claude session resumable after its workspace root changes.
//
// The CLI stores a session as `<configRoot>/projects/<slug(cwd)>/<id>.jsonl`
// and looks `resume` up in the project directory derived from the CWD of the
// *current* process — not in the one that wrote the transcript. So changing a
// conversation's CWD and relaunching the worker leaves every following turn
// failing with `No conversation found with session ID: <id>`, permanently: the
// id stays pinned in `runtime_sessions`, and the transcript stays behind in the
// old workspace's project directory.
//
// Before a resuming turn starts, the transcript (and the sibling `<id>/`
// directory holding subagent and tool-result files) is therefore moved into the
// project directory for the current CWD.
//
// Moved, not copied: a copy left behind in the old directory is resumed again —
// with its now-stale history — the moment the conversation switches back, which
// silently drops every turn taken in between.
//
// The slug is built from the *real* path. The CLI resolves symlinks before
// slugifying, so a symlinked workspace root (`/tmp` on macOS, a linked
// checkout) otherwise targets a directory the CLI never reads.

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROJECT_DIRS_SCANNED = 500;

function isFile(fs, candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(fs, candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function modifiedAtMs(fs, candidate) {
  try {
    return Number(fs.statSync(candidate).mtimeMs) || 0;
  } catch {
    return 0;
  }
}

/**
 * Move `source` to `target`, falling back to copy+delete when the two live on
 * different filesystems (`CLAUDE_CONFIG_DIR` on another mount than `$HOME`).
 */
function movePath(fs, source, target, { recursive = false } = {}) {
  try {
    fs.renameSync(source, target);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }
  if (recursive) {
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
    return;
  }
  fs.copyFileSync(source, target);
  fs.rmSync(source, { force: true });
}

/**
 * Move the session's sibling directory, merging into an existing target rather
 * than replacing it. The source must always end up gone: a leftover `<id>/`
 * still anchors the session to the old project directory for the relay's
 * Session-root resolver, which would keep the file explorer pointed at it.
 */
function moveSessionDir(fs, source, target) {
  if (!isDirectory(fs, target)) {
    movePath(fs, source, target, { recursive: true });
    return;
  }
  // Existing target files win — they belong to the session as it runs now.
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  fs.rmSync(source, { recursive: true, force: true });
}

/**
 * Find every project directory that currently holds `<nativeSessionId>.jsonl`,
 * newest first. Bounded and never recursive: one readdir per configured root
 * plus one stat per project directory.
 */
function findTranscriptSources({ fs, path, roots, nativeSessionId, excludeDir }) {
  const transcriptName = `${nativeSessionId}.jsonl`;
  const matches = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    let scanned = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (scanned >= MAX_PROJECT_DIRS_SCANNED) break;
      scanned += 1;
      const projectDir = path.join(root, entry.name);
      if (path.resolve(projectDir) === excludeDir) continue;
      const transcriptPath = path.join(projectDir, transcriptName);
      if (!isFile(fs, transcriptPath)) continue;
      matches.push({ projectDir, transcriptPath, modifiedAtMs: modifiedAtMs(fs, transcriptPath) });
    }
  }
  return matches.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
}

/**
 * Ensure the session `nativeSessionId` is resumable from `cwd`.
 *
 * Never throws: a relocation that cannot be completed leaves the CLI to report
 * the missing session exactly as it did before, which is strictly better than
 * failing a turn that might not even have needed the transcript.
 *
 * @returns {{ status: 'skipped'|'present'|'moved'|'missing'|'failed', from?: string, to?: string, error?: string }}
 */
export function relocateClaudeTranscriptForCwd({
  nativeSessionId = '',
  cwd = '',
  fs = nodeFs,
  path = nodePath,
  env = process.env,
  homedir = os.homedir,
  dbg = () => {},
} = {}) {
  const sessionId = String(nativeSessionId || '').trim();
  const workspaceRoot = String(cwd || '').trim();
  // The id is joined into a filesystem path, so it is validated before any
  // syscall rather than trusted.
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || !workspaceRoot) return { status: 'skipped' };

  const roots = resolveClaudeProjectsRoots({ env, homedir, path });
  if (!roots.length) return { status: 'skipped' };

  try {
    let resolvedRoot = workspaceRoot;
    try {
      resolvedRoot = fs.realpathSync(workspaceRoot);
    } catch {
      // A workspace root that no longer exists cannot be resolved; the slug of
      // the literal path is still the best guess.
    }
    // The CLI reads `CLAUDE_CONFIG_DIR` first and falls back to `~/.claude`,
    // which is the order `resolveClaudeProjectsRoots` returns.
    const targetProjectDir = path.join(roots[0], claudeProjectDirSlug(resolvedRoot));
    const targetTranscriptPath = path.join(targetProjectDir, `${sessionId}.jsonl`);
    if (isFile(fs, targetTranscriptPath)) return { status: 'present', to: targetTranscriptPath };

    const sources = findTranscriptSources({
      fs,
      path,
      roots,
      nativeSessionId: sessionId,
      excludeDir: path.resolve(targetProjectDir),
    });
    if (!sources.length) return { status: 'missing', to: targetTranscriptPath };

    const source = sources[0];
    fs.mkdirSync(targetProjectDir, { recursive: true });
    movePath(fs, source.transcriptPath, targetTranscriptPath);

    // The sibling directory is created lazily — only once the session produces
    // subagent or tool-result files — so its absence is normal.
    const sourceSessionDir = path.join(source.projectDir, sessionId);
    if (isDirectory(fs, sourceSessionDir)) {
      moveSessionDir(fs, sourceSessionDir, path.join(targetProjectDir, sessionId));
    }

    dbg(`relocated claude transcript ${sessionId} from ${source.projectDir} to ${targetProjectDir}`);
    return { status: 'moved', from: source.transcriptPath, to: targetTranscriptPath };
  } catch (error) {
    const message = error?.message || String(error);
    dbg(`claude transcript relocation failed for ${sessionId}: ${message}`);
    return { status: 'failed', error: message };
  }
}
