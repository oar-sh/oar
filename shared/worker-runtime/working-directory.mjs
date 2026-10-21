// The session's working directory, checked before a runtime is started in it.
//
// A session runs in the folder it was given (COPILOT_WORKSPACE_ROOT). When that
// folder is gone (deleted, renamed, a drive unmounted), spawning a process in
// it fails with ENOENT, the code a missing executable has too, and each SDK
// takes it for that: the Claude Agent SDK reports a native binary that "exists
// but failed to launch" and blames the libc, Grok's classifier a CLI that is
// not installed. The workers check the folder before they start anything in
// it, and put a launch error that happens while the folder is missing down to
// the folder. A tmux launch does not catch it earlier: `tmux new-session -c`
// falls back to the home folder, so the worker starts and only the folder in
// its environment is wrong.

import fs from 'node:fs';

export const WORKING_DIRECTORY_MISSING_CODE = 'working-directory-missing';

export const WORKING_DIRECTORY_GUIDANCE =
  'Restore the folder, or choose another working directory for this conversation (⋯ → Change CWD), '
  + 'then send the message again.';

// What a failed launch says, in the words of the SDKs: Node's spawn error, the
// Claude Agent SDK's own wording for it.
const LAUNCH_FAILURE_TEXT = /\bENOENT\b|\bspawn\b|failed to launch|failed to spawn|not found at/i;

/**
 * The error a turn fails with when `cwd` cannot be worked in, or null when it
 * can. Only an answer that the folder is not there counts: a folder that
 * cannot be read (EACCES, a network drive that does not answer) is left to the
 * launch, which says more about it than a guess would.
 */
export function missingWorkingDirectoryError(cwd, { statSync = fs.statSync } = {}) {
  const folder = String(cwd || '').trim();
  if (!folder) return null;
  let stats = null;
  try {
    stats = statSync(folder);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null;
  }
  if (stats?.isDirectory()) return null;
  const error = new Error(stats
    ? `The working directory of this conversation is not a folder: ${folder}.`
    : `The working directory of this conversation no longer exists: ${folder}.`);
  error.code = WORKING_DIRECTORY_MISSING_CODE;
  error.workingDirectory = folder;
  error.guidance = WORKING_DIRECTORY_GUIDANCE;
  return error;
}

export function isWorkingDirectoryMissingError(error) {
  return error?.code === WORKING_DIRECTORY_MISSING_CODE;
}

/**
 * A launch that failed while the folder is missing failed because of it: the
 * folder's error in its place. Any other error, or one that does not look like
 * a failed launch, is returned as it is.
 */
export function explainLaunchFailure(error, cwd, { check = missingWorkingDirectoryError } = {}) {
  if (isWorkingDirectoryMissingError(error)) return error;
  const text = `${error?.code || ''} ${error?.message || error || ''}`;
  if (!LAUNCH_FAILURE_TEXT.test(text)) return error;
  return check(cwd) || error;
}
