'use strict';

import crypto from 'node:crypto';

import { deriveRelayKey } from './file-capability.mjs';

// Media tags (`t`): GET /api/media/:id/content goes on the cookie alone (an
// <img> or a <video> in the gallery cannot send the session's proof key),
// and media ids count up from 1. So the id alone opens nothing: every
// address of the route the relay hands out carries a tag,
//
//   /api/media/<id>/content?t=<HMAC-SHA256 over `media:<id>`, 128 bits, base64url>
//
// under a key only the relay holds, derived from the agentKey in
// relay-secrets.json with a label of its own (or a key of this process when
// there is none). A tag never expires: the address stays the same, so a
// browser may keep the picture; it changes when the agentKey does, and the
// old addresses then stop working. The route refuses a missing or wrong tag
// with 404 before it reads anything, whoever asks.

export const MEDIA_TAG_PARAM = 't';
const KEY_LABEL = 'oar media tag key v1';
const TAG_BYTES = 16;
const TAG_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ID_PATTERN = /^\d{1,15}$/;

/** The media tag key from the agentKey bytes (32 bytes), or null. */
export function deriveMediaTagKey(agentKey) {
  return deriveRelayKey(agentKey, KEY_LABEL);
}

/** The first `t` of a request's query (Express may hand an array), '' for none. */
export function mediaTagOf(req) {
  const value = req?.query?.[MEDIA_TAG_PARAM];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

/**
 * @param {object} options
 * @param {() => Buffer|null} options.getKey  the derived key, read live
 */
export function createMediaTags({ getKey = () => null, randomBytes = crypto.randomBytes } = {}) {
  const processKey = randomBytes(32);

  function key() {
    let derived = null;
    try { derived = getKey(); } catch { derived = null; }
    return Buffer.isBuffer(derived) && derived.length >= 16 ? derived : processKey;
  }

  function idText(id) {
    const text = String(id ?? '');
    return ID_PATTERN.test(text) ? String(Number(text)) : '';
  }

  /** The tag of media id `id`; '' for no id. */
  function tagFor(id) {
    const text = idText(id);
    if (!text) return '';
    return crypto.createHmac('sha256', key()).update(`media:${text}`).digest().subarray(0, TAG_BYTES).toString('base64url');
  }

  /** True when `tag` is the tag of `id` (compared in constant time). */
  function matches(id, tag) {
    const presented = String(tag ?? '');
    if (!TAG_PATTERN.test(presented)) return false;
    const expected = tagFor(id);
    if (!expected) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** The address of the route for `id`, with its tag. */
  function contentUrlFor(id) {
    const text = idText(id);
    return text ? `/api/media/${text}/content?${MEDIA_TAG_PARAM}=${tagFor(text)}` : null;
  }

  return { tagFor, matches, contentUrlFor };
}
