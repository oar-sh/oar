'use strict';

// The request's Cookie header, read the way a browser may send it.
//
// - A value with a malformed `%` escape is skipped (that cookie only), never
//   a thrown URIError that ends the request with a 500.
// - A name can come more than once: a cookie of the same name set for a
//   longer path, or by another relay on another port of the same host
//   (cookies are per host, not per port). `parseCookies` keeps the first
//   readable value of each name; `cookieValues` gives every readable one, in
//   header order, so the caller can use the first that is valid.

function decodeValue(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function* cookiePairs(header) {
  for (const part of String(header || '').split(/;\s*/)) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const value = decodeValue(part.slice(idx + 1).trim());
    if (value === null) continue;
    yield [key, value];
  }
}

/** `{ name: value }`, the first readable value of each name. */
export function parseCookies(header) {
  const cookies = {};
  for (const [key, value] of cookiePairs(header)) {
    if (!Object.prototype.hasOwnProperty.call(cookies, key)) cookies[key] = value;
  }
  return cookies;
}

/** Every readable value of one cookie name, in header order (none: []). */
export function cookieValues(header, name) {
  const wanted = String(name || '');
  const values = [];
  if (!wanted) return values;
  for (const [key, value] of cookiePairs(header)) {
    if (key === wanted) values.push(value);
  }
  return values;
}
