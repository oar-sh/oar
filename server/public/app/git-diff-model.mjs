'use strict';

// Pure parsing/shaping helpers for the git diff viewer. The server returns a
// unified diff generated with a huge context window (-U999999), so a single
// patch carries the whole file: "full" mode renders every line, "changes"
// mode collapses long context runs into gap markers.

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patchText) {
  const text = String(patchText || '');
  const result = {
    lines: [],
    isBinary: /^Binary files .* differ$/m.test(text),
    additions: 0,
    deletions: 0,
    isEmpty: false,
  };
  if (result.isBinary) return result;

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    const header = raw.match(HUNK_HEADER_PATTERN);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) {
      result.lines.push({ type: 'add', text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      result.additions += 1;
    } else if (raw.startsWith('-')) {
      result.lines.push({ type: 'del', text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      result.deletions += 1;
    } else if (raw.startsWith(' ')) {
      result.lines.push({ type: 'context', text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else if (raw.startsWith('diff --git')) {
      inHunk = false;
    }
    // Anything else inside a hunk (empty trailing split artifact) is skipped.
  }
  result.isEmpty = result.lines.length === 0;
  return result;
}

// Collapse context runs for "changes only" mode: keep `contextLines` context
// around every add/del line, replace longer runs with {type:'gap', count}.
export function collapseContextLines(lines, contextLines = 3) {
  const source = Array.isArray(lines) ? lines : [];
  const keep = new Array(source.length).fill(false);
  source.forEach((line, index) => {
    if (line.type !== 'add' && line.type !== 'del') return;
    const from = Math.max(0, index - contextLines);
    const to = Math.min(source.length - 1, index + contextLines);
    for (let i = from; i <= to; i += 1) keep[i] = true;
  });
  const collapsed = [];
  let gap = 0;
  const flushGap = () => {
    if (gap > 0) collapsed.push({ type: 'gap', count: gap });
    gap = 0;
  };
  source.forEach((line, index) => {
    if (keep[index]) {
      flushGap();
      collapsed.push(line);
    } else {
      gap += 1;
    }
  });
  flushGap();
  return collapsed;
}

const STATUS_LABELS = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Untracked',
  T: 'Type changed',
};

export function describeGitFileStatus(statusCode) {
  const code = String(statusCode || '').trim().toUpperCase();
  return STATUS_LABELS[code] || 'Changed';
}

export function summarizeGitStatusHeader(status) {
  const parts = [];
  const branch = String(status?.branch || '').trim();
  if (status?.detached) parts.push('detached HEAD');
  else if (branch) parts.push(branch);
  const ahead = Number(status?.ahead || 0);
  const behind = Number(status?.behind || 0);
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(' ');
}
