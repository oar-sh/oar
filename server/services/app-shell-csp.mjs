// The Content-Security-Policy of the app shell (the page itself, a shared
// link's reader, "Preview as shared"): Stage A of the page policy.
//
// No hostname, IP address or port, and nothing read from a setting: every
// source is `'self'`, which the browser resolves against the origin it loaded
// the page from (scheme, host and port). So it holds unchanged for
// http://192.168.1.20:3333, a self-signed https origin, a single-word host
// like http://devbox:3333, an invented top-level domain, and a user who moves
// from an IP to a name later.
//
// Inline code stays allowed (`'unsafe-inline'` for scripts and styles): the
// UI still uses inline <script> blocks and inline event handlers. This stage
// blocks every OTHER origin: a script, style, font, image, request or form
// going anywhere but the relay. Dropping `'unsafe-inline'` from `script-src`
// is Stage B, a separate change.
//
// What each directive covers, from an inventory of what the UI loads:
//  - script-src: the UI's own files, Socket.IO's client (same-origin
//    /socket.io/socket.io.js) and the browser libraries served locally. There
//    is no eval and no `new Function` in the app code, so no 'unsafe-eval'.
//  - style-src: own files, inline <style> and style="" attributes.
//  - img-src: own images, `data:` (pasted and annotated pictures, inline
//    data:image in a reply) and `blob:` (a picture opened from a File).
//    A remote picture in an agent's reply is NOT allowed, on purpose: its
//    URL can carry data out. The markdown renderer shows it as a link.
//  - connect-src: fetch/XHR, EventSource and WebSocket. Socket.IO connects
//    to the page's own origin under `${BASE}/socket.io/`. The CSP3 `'self'`
//    keyword matches the ws:/wss: URLs of the page's own host and port, for
//    an http page as for an https one (CSP Level 3, section 6.7.2.8 "Does url
//    match expression in origin with redirect count?": `'self'` matches a url
//    of the same origin, and one of the same host and port whose scheme is
//    ws/wss for an http/https origin; section 6.7.2.9 gives the scheme
//    equivalences). MDN notes that some older browsers did not resolve
//    `'self'` to websocket schemes; no per-request websocket source is built,
//    and tests/csp-stage-a.spec.mjs fails on any violation, so a browser that
//    blocked the socket would show. `data:` and `blob:` are there for fetch()
//    of an inline or object-URL picture (the annotate editor); both are local
//    to the page, so they open no way out.
//  - font-src, worker-src, manifest-src: own files only (KaTeX's fonts, the
//    service worker, the web manifest).
//  - media-src: own files and `blob:` (a recorded or picked clip).
//  - frame-src is absent on purpose: the UI embeds no iframe. A preview is a
//    link (<a target="_blank">) to the preview listener, another origin, so
//    opening it is a navigation, which this policy does not govern. Were a
//    frame added later, `default-src 'self'` would refuse it loudly.
//  - object-src 'none', base-uri 'self', form-action 'self': no plugins, no
//    <base> hijack, no form posting elsewhere.
//  - frame-ancestors 'self': only this origin may frame the shell (the CSP
//    form of X-Frame-Options: SAMEORIGIN; agent auth section 13.4).
//
// Served files carry their own, stricter sandbox policy
// (services/safe-served-content.mjs); the preview proxy is another listener
// with its own headers.
export const APP_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' data: blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
