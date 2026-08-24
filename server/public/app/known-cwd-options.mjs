// Known-CWD option list shared by the Change CWD modal (cwd-picker.js) and the
// New Chat modal (journal-view.js). Pure module: callers pass in the store and
// repo-browser values so the list stays testable without a DOM.

// Mirrors normalizeDriveLetterOnlyPath in server/services/workspace-root-path-policy.mjs.
// It cannot be imported: only server/public is served to the browser.
export function normalizeKnownCwdPath(value) {
  const stripped = String(value || '').trim().replace(/[\\/]+$/, '');
  // Always restore the trailing backslash for Windows drive roots ("D:" → "D:\").
  // Without it, sending "D:" to the server causes path.resolve("D:") to return the
  // server's remembered CWD for drive D, not the drive root.
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

export function buildKnownCwdOptions({
  currentSessionCwd = '',
  workspaceRootPath = '',
  browserCwd = '',
  recentRoots = [],
} = {}) {
  const options = [];
  const seen = new Set();
  const add = (label, value, note = '') => {
    const pathValue = normalizeKnownCwdPath(value);
    if (!pathValue) return;
    const key = pathValue.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ label, path: pathValue, note });
  };

  add('Current session CWD', currentSessionCwd, 'Selected session');
  add('Relay workspace', workspaceRootPath, 'Relay host cwd');
  add('Current browser folder', browserCwd, 'From file explorer');
  const history = Array.isArray(recentRoots) ? recentRoots : [];
  history.forEach((pathValue, index) => {
    add(`Recent CWD ${index + 1}`, pathValue, 'Relay history');
  });
  return options;
}
