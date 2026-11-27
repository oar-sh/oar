// The base path the app works out from the address when the page it came in
// did not carry one (a relay at the root sends basePath ''). Every asset,
// API and socket URL is `${base}/…`, so the base must stay a path on this
// origin: '' or '/segment[/segment…]' of plain URL path characters. Anything
// else gives '': an empty segment ('//host' would turn those URLs into another
// host's), a backslash (browsers read '\' as '/'), either percent-encoded, and
// any '&', ';', quote or angle bracket, since the page writes the base into
// HTML (document.write), where the parser decodes '&sol;' to '/'.
// index.html runs the same functions inline before any module loads;
// app-base.test.mjs keeps the two identical.

// app-base:start
function appBaseFromPathname(pathname) {
  const path = String(pathname || '/');
  const sharedIndex = path.indexOf('/shared/');
  const previewIndex = path.indexOf('/share-preview/');
  const end = sharedIndex >= 0 ? sharedIndex : previewIndex >= 0 ? previewIndex : path.length;
  const base = path.slice(0, end).replace(/\/+$/, '');
  if (!/^(?:\/[A-Za-z0-9._~%-]+)*$/.test(base)) return '';
  try {
    const decoded = decodeURIComponent(base);
    return decoded.includes('//') || decoded.includes('\\') ? '' : base;
  } catch {
    return '';
  }
}
function escapeHtmlAttribute(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
// app-base:end

export { appBaseFromPathname, escapeHtmlAttribute };
