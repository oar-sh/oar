// Web Push (RFC 8030) on node:crypto and fetch: the VAPID header (RFC 8292)
// and the aes128gcm message encryption (RFC 8291, RFC 8188 framing).
//
// The default export is a plain object with the method names of the web-push
// package (`generateVAPIDKeys`, `setVapidDetails`, `sendNotification`), so
// callers keep calling through it and a test relay's preload can swap a method
// on it. Keys are stored in the web-push package format: base64url of the raw
// uncompressed P-256 point (65 bytes) and of the private scalar (32 bytes).

import crypto from 'node:crypto';

// Four weeks, the web-push package default.
const DEFAULT_TTL_SECONDS = 4 * 7 * 24 * 60 * 60;
const VAPID_JWT_SECONDS = 12 * 60 * 60;
// A cached JWT is renewed this long before it expires.
const VAPID_JWT_RENEW_SECONDS = 60 * 60;
const RECORD_SIZE = 4096;
// salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(65), the RFC 8188 header with the
// sender's public key as keyid.
const HEADER_BYTES = 16 + 4 + 1 + 65;
const TAG_BYTES = 16;
// One record, and the whole body within the 4096 bytes every push service
// takes: header, payload, the 0x02 delimiter and the tag.
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);
const OPTION_KEYS = new Set(['TTL', 'urgency', 'topic', 'timeout']);
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** A push service's non-2xx answer, shaped like the web-push package's WebPushError. */
export class WebPushError extends Error {
  constructor(message, statusCode, headers, body, endpoint) {
    super(message);
    this.name = 'WebPushError';
    this.statusCode = statusCode;
    this.headers = headers;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function decodeKey(value, label, length) {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) {
    throw new Error(`${label} must be a URL safe Base 64 string (without "=").`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length) throw new Error(`${label} should be ${length} bytes long when decoded.`);
  return bytes;
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/** A new VAPID key pair, `{ publicKey, privateKey }` in the web-push package format. */
export function generateVAPIDKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d };
}

export function validateSubject(subject) {
  if (!subject || typeof subject !== 'string') {
    throw new Error('The VAPID subject must be a string containing an https: URL or mailto: address.');
  }
  let parsed;
  try {
    parsed = new URL(subject);
  } catch {
    throw new Error(`VAPID subject is not a valid URL. ${subject}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
    throw new Error(`VAPID subject is not an https: or mailto: URL. ${subject}`);
  }
}

/** The ES256 signing key for a stored pair; x and y come from the public point. */
export function vapidSigningKey(publicKey, privateKey) {
  const point = decodeKey(publicKey, 'VAPID public key', 65);
  if (point[0] !== 0x04) throw new Error('VAPID public key must be an uncompressed P-256 point.');
  decodeKey(privateKey, 'VAPID private key', 32);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
      d: privateKey,
    },
  });
}

/** A VAPID JWT: ES256 with the 64-byte r‖s signature JWS asks for. */
export function signVapidJwt({ audience, subject, expiresAt, signingKey }) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: audience, exp: expiresAt, sub: subject })}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key: signingKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

/**
 * `authorization(endpoint)` gives the `Authorization` header for a push to
 * that endpoint. The JWT's audience is the endpoint's origin; one JWT per
 * origin is kept until an hour before it expires. `now` is in milliseconds.
 */
export function createVapidAuthorizer({ subject, publicKey, privateKey, now = Date.now }) {
  validateSubject(subject);
  const signingKey = vapidSigningKey(publicKey, privateKey);
  const cache = new Map();
  return {
    authorization(endpoint) {
      const audience = new URL(endpoint).origin;
      const nowSeconds = Math.floor(now() / 1000);
      let entry = cache.get(audience);
      if (!entry || nowSeconds >= entry.expiresAt - VAPID_JWT_RENEW_SECONDS) {
        const expiresAt = nowSeconds + VAPID_JWT_SECONDS;
        entry = { expiresAt, token: signVapidJwt({ audience, subject, expiresAt, signingKey }) };
        cache.set(audience, entry);
      }
      return `vapid t=${entry.token}, k=${publicKey}`;
    },
  };
}

/**
 * The aes128gcm body for a payload to a subscription's keys, as one record.
 * `salt` and `senderPrivateKey` are for tests only (both random otherwise).
 */
export function encryptPayload(payload, keys, { salt = crypto.randomBytes(16), senderPrivateKey = null } = {}) {
  const uaPublic = decodeKey(keys?.p256dh, 'The subscription p256dh key', 65);
  if (typeof keys?.auth !== 'string' || !BASE64URL_RE.test(keys.auth)) {
    throw new Error('The subscription auth key must be a URL safe Base 64 string.');
  }
  const authSecret = Buffer.from(keys.auth, 'base64url');
  if (authSecret.length < 16) throw new Error('The subscription auth key should be at least 16 bytes long.');
  const plaintext = Buffer.from(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload is ${plaintext.length} bytes; at most ${MAX_PAYLOAD_BYTES} fit in one push message.`);
  }

  const sender = crypto.createECDH('prime256v1');
  if (senderPrivateKey) sender.setPrivateKey(senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(HEADER_BYTES);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  return Buffer.concat([header, record]);
}

function requestHeaders(options) {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new Error(`'${key}' is an invalid option. The valid options are ${[...OPTION_KEYS].join(', ')}.`);
  }
  const ttl = options.TTL === undefined ? DEFAULT_TTL_SECONDS : Number(options.TTL);
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error('TTL should be a number and should be at least 0.');
  const urgency = options.urgency || 'normal';
  if (!URGENCIES.has(urgency)) throw new Error('Unsupported urgency specified.');
  const headers = { TTL: String(Math.floor(ttl)), Urgency: urgency };
  if (options.topic) {
    if (!BASE64URL_RE.test(options.topic) || options.topic.length > 32) {
      throw new Error('Topic must be at most 32 characters of the URL safe Base 64 set.');
    }
    headers.Topic = options.topic;
  }
  return headers;
}

/** A sender with its own VAPID details; the default export is one of these. */
export function createWebPushSender({ now = Date.now } = {}) {
  let vapid = null;

  async function sendNotification(subscription, payload, options = {}) {
    const endpoint = subscription?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) throw new Error('You must pass in a subscription with at least an endpoint.');
    if (!vapid) throw new Error('VAPID details are not set; call setVapidDetails first.');
    if (payload != null && typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
      throw new Error('Payload must be either a string or a Node Buffer.');
    }
    const headers = requestHeaders(options || {});
    headers.Authorization = vapid.authorization(endpoint);
    let body;
    if (payload != null && payload.length > 0) {
      body = encryptPayload(payload, subscription.keys);
      headers['Content-Encoding'] = 'aes128gcm';
      headers['Content-Type'] = 'application/octet-stream';
    }
    const timeout = Number(options?.timeout);
    const signal = Number.isFinite(timeout) && timeout > 0 ? AbortSignal.timeout(timeout) : undefined;

    let response;
    let text;
    try {
      // A redirect is an answer like any other non-2xx: following it would
      // turn the push into a GET without body or Authorization.
      response = await fetch(endpoint, { method: 'POST', headers, body, signal, redirect: 'manual' });
      text = await response.text();
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error(`Push request timed out after ${timeout} ms`, { cause: error });
      throw new Error(`Push request failed: ${error?.cause?.message || error?.message || error}`, { cause: error });
    }
    const responseHeaders = Object.fromEntries(response.headers);
    if (response.status < 200 || response.status > 299) {
      throw new WebPushError('Received unexpected response code', response.status, responseHeaders, text, endpoint);
    }
    return { statusCode: response.status, body: text, headers: responseHeaders };
  }

  return {
    generateVAPIDKeys,
    setVapidDetails(subject, publicKey, privateKey) {
      vapid = createVapidAuthorizer({ subject, publicKey, privateKey, now });
    },
    sendNotification,
  };
}

export default createWebPushSender();
