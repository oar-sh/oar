// A download link has to change when the file behind it changes. The address
// and the name a file is saved under both carry the file's version, so nothing
// between the relay and the Downloads folder can hand back an older copy:
// not a download manager or a proxy keyed on the URL, and not a phone that
// keeps `name.pdf`, `name (1).pdf`, `name (2).pdf` side by side and opens the
// first.

export function appendUrlParam(url, key, value) {
  const base = String(url || '');
  const text = String(value ?? '');
  if (!base || !text) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(text)}`;
}

/** `href` with the file's version token (`v=…`) appended; unchanged when there is none or it has one. */
export function versionedFileHref(href, version) {
  const base = String(href || '');
  if (/[?&]v=/.test(base)) return base;
  return appendUrlParam(base, 'v', version);
}

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

/**
 * The name to save a download under: the file's own name with the time it was
 * last changed, `report.pdf` → `report (1005-0719).pdf` (month, day, hour,
 * minute, local time). Two versions of a file get two names, and the name
 * says which one is open. Without a known time the name stays as it is.
 */
export function stampedDownloadName(name, mtimeMs) {
  const plain = String(name || '').trim();
  const time = Number(mtimeMs);
  if (!plain || !Number.isFinite(time) || time <= 0) return plain;
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return plain;
  const stamp = `${twoDigits(date.getMonth() + 1)}${twoDigits(date.getDate())}-${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}`;
  const dot = plain.lastIndexOf('.');
  // A leading dot is part of the name (`.env`), not the start of an extension.
  if (dot <= 0) return `${plain} (${stamp})`;
  return `${plain.slice(0, dot)} (${stamp})${plain.slice(dot)}`;
}

/**
 * The download link of a previewed file: versioned address, and the stamped
 * name both as the link's `download` name and as `as=…`, which the relay puts
 * into the `Content-Disposition` header (a browser prefers that header over
 * the link's own name).
 */
export function buildDownloadLink({ href, name, version, mtimeMs } = {}) {
  const downloadName = stampedDownloadName(name, mtimeMs);
  let url = versionedFileHref(href, version);
  if (url && downloadName && downloadName !== String(name || '').trim()) {
    url = appendUrlParam(url, 'as', downloadName);
  }
  return { href: url, downloadName };
}
