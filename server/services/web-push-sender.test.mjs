import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import webPushSender, {
  MAX_PAYLOAD_BYTES,
  WebPushError,
  createVapidAuthorizer,
  createWebPushSender,
  encryptPayload,
  generateVAPIDKeys,
  signVapidJwt,
  vapidSigningKey,
} from './web-push-sender.mjs';

// The example of RFC 8291 §5 ("Push Message Encryption Example"); the inputs
// are repeated in Appendix A ("Intermediate Values for Encryption"). The body
// is the §5 request body with its line wrapping removed.
const RFC8291_EXAMPLE = Object.freeze({
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiverPrivateKey: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  receiverPublicKey: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
});

// A key pair made once with web-push 3.6.7's generateVAPIDKeys() for this
// test. It is invented and used nowhere else.
const WEB_PUSH_367_KEYS = Object.freeze({
  publicKey: 'BIG2oyEtrgwxRnnSg90MfuQKdqrMLQQ4FK-cBrDFy5U2O5tqcprfY8O-4aVcVzzHjS9dG_1N8-Q4I8_r9qxQj14',
  privateKey: '_3lzjLyfZk8uTZ3xauMyBwNXKafSw97W16Vxkw1lwUo',
});

const SUBJECT = 'mailto:push@example.com';

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

// The receiver's side of RFC 8291, written out here so the round trip does not
// lean on the module's own derivation.
function decryptBody(body, receiver, authSecret) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  assert.equal(recordSize, 4096);
  assert.equal(idLength, 65);
  assert.ok(record.length <= recordSize, 'one record');
  const ecdhSecret = receiver.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(-16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  assert.equal(padded.at(-1), 0x02, 'last-record delimiter');
  return padded.subarray(0, -1);
}

function makeReceiver() {
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const keys = { p256dh: receiver.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };
  return { receiver, authSecret, keys };
}

function publicKeyObject(rawPoint) {
  const point = Buffer.from(rawPoint, 'base64url');
  return crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
  });
}

function parseVapidHeader(header) {
  const match = /^vapid t=([^,]+), k=(\S+)$/.exec(header);
  assert.ok(match, `vapid header: ${header}`);
  const [encodedHeader, encodedClaims, encodedSignature] = match[1].split('.');
  return {
    token: match[1],
    k: match[2],
    header: JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(encodedClaims, 'base64url').toString()),
    data: Buffer.from(`${encodedHeader}.${encodedClaims}`),
    signature: Buffer.from(encodedSignature, 'base64url'),
  };
}

function verifyJwt(parsed, rawPublicKey) {
  return crypto.verify('sha256', parsed.data, { key: publicKeyObject(rawPublicKey), dsaEncoding: 'ieee-p1363' }, parsed.signature);
}

test('encryption reproduces the RFC 8291 §5 example byte for byte', () => {
  const sender = crypto.createECDH('prime256v1');
  sender.setPrivateKey(Buffer.from(RFC8291_EXAMPLE.senderPrivateKey, 'base64url'));
  assert.equal(sender.getPublicKey().toString('base64url'), RFC8291_EXAMPLE.senderPublicKey, 'the sender key pair of the example');

  const body = encryptPayload(
    RFC8291_EXAMPLE.plaintext,
    { p256dh: RFC8291_EXAMPLE.receiverPublicKey, auth: RFC8291_EXAMPLE.authSecret },
    {
      salt: Buffer.from(RFC8291_EXAMPLE.salt, 'base64url'),
      senderPrivateKey: Buffer.from(RFC8291_EXAMPLE.senderPrivateKey, 'base64url'),
    },
  );
  // 86 + 41 + 1 + 16 bytes; the example's Content-Length line says 145.
  assert.equal(body.length, 144);
  assert.equal(body.toString('base64url'), RFC8291_EXAMPLE.body);
});

test('the test receiver decrypts the RFC 8291 §5 example', () => {
  const receiver = crypto.createECDH('prime256v1');
  receiver.setPrivateKey(Buffer.from(RFC8291_EXAMPLE.receiverPrivateKey, 'base64url'));
  assert.equal(receiver.getPublicKey().toString('base64url'), RFC8291_EXAMPLE.receiverPublicKey);
  const plaintext = decryptBody(Buffer.from(RFC8291_EXAMPLE.body, 'base64url'), receiver, Buffer.from(RFC8291_EXAMPLE.authSecret, 'base64url'));
  assert.equal(plaintext.toString(), RFC8291_EXAMPLE.plaintext);
});

test('a receiver decrypts what encryptPayload makes, up to the maximum payload', () => {
  const { receiver, authSecret, keys } = makeReceiver();
  for (const size of [0, 1, 3000, MAX_PAYLOAD_BYTES]) {
    const payload = crypto.randomBytes(size);
    const body = encryptPayload(payload, keys);
    assert.equal(body.length, 86 + size + 1 + 16, `body length for ${size} bytes`);
    assert.ok(body.length <= 4096);
    assert.deepEqual(decryptBody(body, receiver, authSecret), payload, `${size} bytes`);
  }
  assert.equal(MAX_PAYLOAD_BYTES, 4096 - 86 - 16 - 1);
  assert.throws(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), keys), /at most 3993 fit/);
});

test('each encryption uses a fresh salt and sender key', () => {
  const { keys } = makeReceiver();
  const first = encryptPayload('same', keys);
  const second = encryptPayload('same', keys);
  assert.notDeepEqual(first.subarray(0, 16), second.subarray(0, 16));
  assert.notDeepEqual(first.subarray(21, 86), second.subarray(21, 86));
});

test('encryptPayload refuses bad subscription keys', () => {
  const { keys } = makeReceiver();
  assert.throws(() => encryptPayload('x', { ...keys, p256dh: keys.p256dh.slice(0, 40) }), /p256dh key should be 65 bytes/);
  assert.throws(() => encryptPayload('x', { ...keys, auth: 'c2hvcnQ' }), /at least 16 bytes/);
  assert.throws(() => encryptPayload('x', { p256dh: keys.p256dh }), /auth key must be/);
});

test('the VAPID header carries an ES256 JWT for the endpoint origin that verifies', () => {
  const keys = generateVAPIDKeys();
  const nowMs = Date.UTC(2026, 10, 15, 12, 0, 0);
  const authorizer = createVapidAuthorizer({ subject: SUBJECT, ...keys, now: () => nowMs });

  const parsed = parseVapidHeader(authorizer.authorization('https://push.example.net:443/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV'));
  assert.equal(parsed.k, keys.publicKey);
  assert.deepEqual(parsed.header, { typ: 'JWT', alg: 'ES256' });
  assert.equal(parsed.claims.aud, 'https://push.example.net');
  assert.equal(parsed.claims.sub, SUBJECT);
  assert.ok(parsed.claims.exp > nowMs / 1000);
  assert.ok(parsed.claims.exp <= nowMs / 1000 + 24 * 60 * 60, 'exp at most 24 h ahead (RFC 8292 §2)');
  assert.equal(parsed.signature.length, 64, 'r‖s');
  assert.equal(verifyJwt(parsed, keys.publicKey), true);
  assert.equal(verifyJwt(parsed, generateVAPIDKeys().publicKey), false, 'another key does not verify it');

  const withPort = parseVapidHeader(authorizer.authorization('https://push.example.net:8443/push/x'));
  assert.equal(withPort.claims.aud, 'https://push.example.net:8443');
});

test('the VAPID JWT is cached per origin and renewed before it expires', () => {
  const keys = generateVAPIDKeys();
  let nowMs = Date.UTC(2026, 10, 15, 12, 0, 0);
  const authorizer = createVapidAuthorizer({ subject: SUBJECT, ...keys, now: () => nowMs });
  const endpoint = 'https://fcm.example.net/fcm/send/abc';

  const first = authorizer.authorization(endpoint);
  assert.equal(authorizer.authorization('https://fcm.example.net/fcm/send/other'), first, 'same origin, same token');
  assert.notEqual(authorizer.authorization('https://updates.example.org/wpush/v2/x'), first, 'another origin, another token');

  nowMs += (11 * 60 * 60 - 1) * 1000;
  assert.equal(authorizer.authorization(endpoint), first, 'still more than an hour left');

  nowMs += 1000;
  const renewed = authorizer.authorization(endpoint);
  assert.notEqual(renewed, first);
  const parsed = parseVapidHeader(renewed);
  assert.equal(parsed.claims.exp, Math.floor(nowMs / 1000) + 12 * 60 * 60);
  assert.equal(verifyJwt(parsed, keys.publicKey), true);
});

test('a key pair in web-push 3.6.7 format signs a JWT that verifies', () => {
  const point = Buffer.from(WEB_PUSH_367_KEYS.publicKey, 'base64url');
  const scalar = Buffer.from(WEB_PUSH_367_KEYS.privateKey, 'base64url');
  assert.equal(point.length, 65);
  assert.equal(scalar.length, 32);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(scalar);
  assert.deepEqual(ecdh.getPublicKey(), point, 'the literal is one pair');

  const token = signVapidJwt({
    audience: 'https://fcm.example.net',
    subject: SUBJECT,
    expiresAt: 1_800_000_000,
    signingKey: vapidSigningKey(WEB_PUSH_367_KEYS.publicKey, WEB_PUSH_367_KEYS.privateKey),
  });
  const parsed = parseVapidHeader(`vapid t=${token}, k=${WEB_PUSH_367_KEYS.publicKey}`);
  assert.deepEqual(parsed.claims, { aud: 'https://fcm.example.net', exp: 1_800_000_000, sub: SUBJECT });
  assert.equal(verifyJwt(parsed, WEB_PUSH_367_KEYS.publicKey), true);
});

test('generateVAPIDKeys makes pairs in web-push format: a 65-byte 0x04 point and a 32-byte scalar', () => {
  for (let i = 0; i < 32; i += 1) {
    const keys = generateVAPIDKeys();
    assert.match(keys.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.match(keys.privateKey, /^[A-Za-z0-9_-]+$/);
    const point = Buffer.from(keys.publicKey, 'base64url');
    const scalar = Buffer.from(keys.privateKey, 'base64url');
    assert.equal(point.length, 65);
    assert.equal(point[0], 0x04);
    assert.equal(scalar.length, 32);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    assert.deepEqual(ecdh.getPublicKey(), point);
  }
});

test('setVapidDetails refuses a bad subject or bad keys', () => {
  const sender = createWebPushSender();
  const keys = generateVAPIDKeys();
  assert.throws(() => sender.setVapidDetails('', keys.publicKey, keys.privateKey), /subject must be a string/);
  assert.throws(() => sender.setVapidDetails('not a url', keys.publicKey, keys.privateKey), /not a valid URL/);
  assert.throws(() => sender.setVapidDetails('http://example.com/contact', keys.publicKey, keys.privateKey), /not an https: or mailto: URL/);
  const shortPublic = Buffer.from(keys.publicKey, 'base64url').subarray(0, 64).toString('base64url');
  assert.throws(() => sender.setVapidDetails(SUBJECT, shortPublic, keys.privateKey), /public key should be 65 bytes/);
  const shortPrivate = Buffer.from(keys.privateKey, 'base64url').subarray(0, 31).toString('base64url');
  assert.throws(() => sender.setVapidDetails(SUBJECT, keys.publicKey, shortPrivate), /private key should be 32 bytes/);
  assert.throws(() => sender.setVapidDetails(SUBJECT, `${keys.publicKey}=`, keys.privateKey), /without "="/);
  assert.doesNotThrow(() => sender.setVapidDetails('https://example.com/contact', keys.publicKey, keys.privateKey));
  assert.doesNotThrow(() => sender.setVapidDetails(SUBJECT, WEB_PUSH_367_KEYS.publicKey, WEB_PUSH_367_KEYS.privateKey));
});

test('the default export is a plain object with web-push\'s method names', () => {
  assert.equal(Object.getPrototypeOf(webPushSender), Object.prototype);
  for (const name of ['generateVAPIDKeys', 'setVapidDetails', 'sendNotification']) {
    assert.equal(typeof webPushSender[name], 'function', name);
  }
});

async function startPushService(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      handler(request, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    endpoint: `${origin}/push/sub-1`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

function readySender() {
  const sender = createWebPushSender();
  const vapidKeys = generateVAPIDKeys();
  sender.setVapidDetails(SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);
  return { sender, vapidKeys };
}

test('sendNotification posts the encrypted payload with the push headers and resolves on 201', async () => {
  const service = await startPushService((request, res) => {
    res.writeHead(201, { location: '/message/1' });
    res.end();
  });
  try {
    const { sender, vapidKeys } = readySender();
    const { receiver, authSecret, keys } = makeReceiver();
    const payload = JSON.stringify({ title: 'Reply ready', body: 'Done.' });

    const result = await sender.sendNotification({ endpoint: service.endpoint, keys }, payload, { TTL: 43200, urgency: 'high', timeout: 5000 });
    assert.equal(result.statusCode, 201);
    assert.equal(result.body, '');
    assert.equal(result.headers.location, '/message/1');

    assert.equal(service.requests.length, 1);
    const [request] = service.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/push/sub-1');
    assert.equal(request.headers.ttl, '43200');
    assert.equal(request.headers.urgency, 'high');
    assert.equal(request.headers.topic, undefined);
    assert.equal(request.headers['content-encoding'], 'aes128gcm');
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    assert.equal(Number(request.headers['content-length']), request.body.length);
    const vapid = parseVapidHeader(request.headers.authorization);
    assert.equal(vapid.k, vapidKeys.publicKey);
    assert.equal(vapid.claims.aud, service.origin);
    assert.equal(verifyJwt(vapid, vapidKeys.publicKey), true);
    assert.equal(decryptBody(request.body, receiver, authSecret).toString(), payload);
  } finally {
    await service.close();
  }
});

test('sendNotification defaults to four weeks TTL and normal urgency, and passes a topic', async () => {
  const service = await startPushService((request, res) => {
    res.writeHead(201);
    res.end();
  });
  try {
    const { sender } = readySender();
    const { keys } = makeReceiver();
    await sender.sendNotification({ endpoint: service.endpoint, keys }, 'hi');
    await sender.sendNotification({ endpoint: service.endpoint, keys }, 'hi', { topic: 'reply-ready' });
    assert.equal(service.requests[0].headers.ttl, '2419200');
    assert.equal(service.requests[0].headers.urgency, 'normal');
    assert.equal(service.requests[1].headers.topic, 'reply-ready');
  } finally {
    await service.close();
  }
});

test('sendNotification with a null or empty payload sends no body and no encryption headers', async () => {
  const service = await startPushService((request, res) => {
    res.writeHead(201);
    res.end();
  });
  try {
    const { sender } = readySender();
    await sender.sendNotification({ endpoint: service.endpoint }, null, { TTL: 60 });
    await sender.sendNotification({ endpoint: service.endpoint }, '');
    for (const request of service.requests) {
      assert.equal(request.body.length, 0);
      assert.equal(request.headers['content-encoding'], undefined);
      assert.equal(request.headers['content-type'], undefined);
      assert.match(request.headers.authorization, /^vapid t=/);
    }
  } finally {
    await service.close();
  }
});

test('a non-2xx answer rejects with statusCode, headers, body and endpoint', async () => {
  let status = 0;
  const service = await startPushService((request, res) => {
    res.writeHead(status, { 'content-type': 'text/plain', 'retry-after': '30' });
    res.end(`status ${status}`);
  });
  try {
    const { sender } = readySender();
    const { keys } = makeReceiver();
    for (status of [404, 410, 429, 500]) {
      await assert.rejects(
        sender.sendNotification({ endpoint: service.endpoint, keys }, '{}', { timeout: 5000 }),
        (error) => {
          assert.ok(error instanceof WebPushError);
          assert.ok(error instanceof Error);
          assert.equal(error.message, 'Received unexpected response code');
          assert.equal(error.statusCode, status);
          assert.equal(error.headers['retry-after'], '30');
          assert.equal(error.body, `status ${status}`);
          assert.equal(error.endpoint, service.endpoint);
          return true;
        },
      );
    }
  } finally {
    await service.close();
  }
});

test('a redirect rejects with its statusCode and is not followed', async () => {
  const target = await startPushService((request, res) => {
    res.writeHead(201);
    res.end();
  });
  let status = 0;
  const service = await startPushService((request, res) => {
    res.writeHead(status, { location: target.endpoint });
    res.end(`moved ${status}`);
  });
  try {
    const { sender } = readySender();
    const { keys } = makeReceiver();
    for (status of [301, 307]) {
      await assert.rejects(
        sender.sendNotification({ endpoint: service.endpoint, keys }, '{}', { timeout: 5000 }),
        (error) => {
          assert.ok(error instanceof WebPushError);
          assert.equal(error.message, 'Received unexpected response code');
          assert.equal(error.statusCode, status);
          assert.equal(error.headers.location, target.endpoint);
          assert.equal(error.body, `moved ${status}`);
          assert.equal(error.endpoint, service.endpoint);
          return true;
        },
      );
    }
    assert.equal(service.requests.length, 2);
    assert.equal(target.requests.length, 0, 'the redirect target receives no request');
  } finally {
    await service.close();
    await target.close();
  }
});

test('a push service that stops in the middle of its answer rejects at the timeout without a statusCode', async () => {
  const service = await startPushService((request, res) => {
    res.writeHead(201, { 'content-length': '100' });
    res.write('partial');
  });
  try {
    const { sender } = readySender();
    const { keys } = makeReceiver();
    await assert.rejects(
      sender.sendNotification({ endpoint: service.endpoint, keys }, '{}', { timeout: 150 }),
      (error) => {
        assert.equal(error.statusCode, undefined);
        assert.match(error.message, /timed out after 150 ms/);
        return true;
      },
    );
  } finally {
    await service.close();
  }
});

test('a push service that does not answer rejects at the timeout without a statusCode', async () => {
  const service = await startPushService(() => {});
  try {
    const { sender } = readySender();
    const { keys } = makeReceiver();
    const startedAt = Date.now();
    await assert.rejects(
      sender.sendNotification({ endpoint: service.endpoint, keys }, '{}', { timeout: 150 }),
      (error) => {
        assert.equal(error.statusCode, undefined);
        assert.match(error.message, /timed out after 150 ms/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await service.close();
  }
});

test('a refused connection rejects without a statusCode', async () => {
  const service = await startPushService(() => {});
  await service.close();
  const { sender } = readySender();
  await assert.rejects(sender.sendNotification({ endpoint: service.endpoint }, null, { timeout: 5000 }), (error) => {
    assert.equal(error.statusCode, undefined);
    assert.match(error.message, /^Push request failed: /);
    return true;
  });
});

test('sendNotification rejects bad input before any request', async () => {
  const { sender } = readySender();
  const { keys } = makeReceiver();
  const endpoint = 'http://127.0.0.1:9/push/never';
  await assert.rejects(sender.sendNotification({}, 'x'), /at least an endpoint/);
  await assert.rejects(sender.sendNotification({ endpoint, keys }, 'x', { proxy: 'http://proxy.example.com' }), /'proxy' is an invalid option/);
  await assert.rejects(sender.sendNotification({ endpoint, keys }, 'x', { urgency: 'urgent' }), /Unsupported urgency/);
  await assert.rejects(sender.sendNotification({ endpoint, keys }, 'x', { TTL: -1 }), /TTL should be/);
  await assert.rejects(sender.sendNotification({ endpoint, keys }, 'x', { topic: 'not a topic!' }), /Topic must be/);
  await assert.rejects(sender.sendNotification({ endpoint, keys }, { not: 'a string' }), /string or a Node Buffer/);
  await assert.rejects(sender.sendNotification({ endpoint }, 'x'), /p256dh key/);
  await assert.rejects(createWebPushSender().sendNotification({ endpoint, keys }, 'x'), /VAPID details are not set/);
});
