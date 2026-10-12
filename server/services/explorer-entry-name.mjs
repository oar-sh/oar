// The one rule set for a file or folder name typed in the explorer: a single
// path segment, nothing that could leave the parent, and on Windows nothing
// the filesystem itself refuses. The Windows set applies only when the relay
// runs there; a Linux name such as `a:b` is legal and stays legal.

const MAX_NAME_BYTES = 255;
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validate a name. Returns `{ ok: true, name }` with the trimmed name, or
 * `{ ok: false, error }` with a message fit for the UI.
 */
export function validateEntryName(rawName, { platform = process.platform } = {}) {
  const name = String(rawName ?? '').trim();
  if (!name) return { ok: false, error: 'Enter a name' };
  if (name === '.' || name === '..') return { ok: false, error: 'That name is not allowed' };
  if (/[/\\\0]/.test(name)) return { ok: false, error: 'A name cannot contain / or \\' };
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return { ok: false, error: 'That name is too long' };
  if (platform === 'win32') { // host-platform: Windows filesystem naming rules
    if (WINDOWS_FORBIDDEN_CHARS.test(name)) return { ok: false, error: 'A name cannot contain < > : " | ? *' };
    if (/[. ]$/.test(name)) return { ok: false, error: 'A name cannot end with a dot or a space' };
    if (WINDOWS_RESERVED_NAMES.test(name)) return { ok: false, error: 'That name is reserved by Windows' };
  }
  return { ok: true, name };
}
