'use strict';

import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';

import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_HEADERS,
  REMOTE_RELAY_LIMITS,
} from '../../shared/remote-relay-contract.mjs';
import { RemoteRelayError, remoteRelayHttpError } from './remote-relay-client.mjs';
import { markRemoteRelayLoopbackRequest } from './remote-relay-inbound.mjs';

// The client for the local target: this relay as a relay its own agents work
// on. It has the outbound client's `request(relay, method, path, options)`,
// but instead of opening a connection it hands the request to the relay's own
// HTTP handler in-process. So a session an agent creates here goes through the
// very routes a paired relay's request reaches (bootstrap, message,
// conversation, questions, cancel-turn, archive) with their validation, their
// provenance and their events, and there is no second implementation of what a
// created session is or how reading, stopping and answering work.
//
// The request carries what the outbound client sends: the bearer token (the
// routes sit behind `auth`), Accept, and the two x-oar-remote-* headers, so the
// routes treat it as an agent's request (approval cards stay hidden, nothing
// unlocks, the composer draft is left alone). It is also marked as built here
// (markRemoteRelayLoopbackRequest), which is what lets it past the inbound
// switch and lets its origin say `local: true`; nothing sent over HTTP can
// claim that.

function toText(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function relayLabel(relay) {
  const name = toText(relay?.name);
  return name ? `Relay "${name}"` : 'This relay';
}

function buildUrl(path, query) {
  const route = String(path || '');
  if (!route.startsWith('/') || route.startsWith('//')) {
    throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.invalidInput, `Invalid path: ${route.slice(0, 80)}`);
  }
  const params = new URLSearchParams();
  if (isPlainObject(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return search ? `${route}?${search}` : route;
}

/** A socket that goes nowhere: the response's bytes are read off the response itself. */
function createNullSocket() {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
  });
  socket.remoteAddress = '127.0.0.1';
  socket.setTimeout = () => socket;
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  return socket;
}

function toBuffer(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

export function createRemoteRelayLoopbackClient({
  // The relay's own request handler: `(req, res) => void` (the Express app).
  handle,
  getOwnRelayId = () => '',
  getOwnToken = () => '',
  timeoutMs: defaultTimeoutMs = REMOTE_RELAY_LIMITS.requestTimeoutMs,
  maxBytes = REMOTE_RELAY_LIMITS.responseMaxBytes,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  /** Runs one request through the handler. Resolves `{ status, text }`. */
  function inject({ method, url, headers, body, hasBody, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const socket = createNullSocket();
      const req = new IncomingMessage(socket);
      req.method = method;
      req.url = url;
      req.headers = headers;
      req.rawHeaders = Object.entries(headers).flat();
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;
      req.httpVersion = '1.1';
      if (hasBody) {
        // What the wire would deliver: JSON, parsed. `_body` tells the JSON
        // body parser the body is already there.
        req.body = JSON.parse(JSON.stringify(body));
        req._body = true;
      }
      req.complete = true;
      req.push(null);
      markRemoteRelayLoopbackRequest(req);

      const res = new ServerResponse(req);
      res.assignSocket(socket);
      // An HTTP server forwards its socket's drain to the response; a handler
      // that streams its answer waits for it.
      socket.on('drain', () => res.emit('drain'));
      const chunks = [];
      let total = 0;
      let settled = false;
      let timer = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutImpl(timer);
        try { res.detachSocket(socket); } catch {}
        try { socket.destroy(); } catch {}
        if (error) reject(error);
        else resolve(value);
      };
      const collect = (chunk, encoding) => {
        const buffer = toBuffer(chunk, encoding);
        if (!buffer || !buffer.length) return;
        total += buffer.length;
        if (total <= maxBytes) chunks.push(buffer);
      };
      const write = res.write;
      const end = res.end;
      res.write = function writeCollected(chunk, encoding, callback) {
        collect(chunk, encoding);
        return write.call(this, chunk, encoding, callback);
      };
      res.end = function endCollected(chunk, encoding, callback) {
        collect(chunk, encoding);
        return end.call(this, chunk, encoding, callback);
      };
      res.once('finish', () => {
        if (total > maxBytes) {
          finish(new RemoteRelayError(
            REMOTE_RELAY_ERROR_CODES.unsupported,
            `This relay's answer is larger than ${maxBytes} bytes`,
            { detail: 'response too large' },
          ));
          return;
        }
        finish(null, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.once('error', (error) => finish(error));

      if (timeoutMs > 0) {
        timer = setTimeoutImpl(() => finish(new RemoteRelayError(
          REMOTE_RELAY_ERROR_CODES.offline,
          `This relay did not answer its own request within ${Math.round(timeoutMs / 100) / 10} s`,
          { detail: 'loopback timeout' },
        )), timeoutMs);
        timer?.unref?.();
      }

      try {
        handle(req, res);
      } catch (error) {
        finish(error);
      }
    });
  }

  /**
   * One call to this relay's own API. `relay` is the dispatcher's local target
   * (only its name is used, for messages). Resolves to the parsed JSON body
   * (null when empty); rejects with a RemoteRelayError, like the outbound
   * client's request.
   */
  async function request(relay, method, path, { body, query, hops = 0, timeoutMs } = {}) {
    if (typeof handle !== 'function') {
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unsupported, 'This relay cannot call its own API', { detail: 'no handler' });
    }
    const token = toText(getOwnToken?.());
    if (!token) {
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, 'This relay has no token configured');
    }
    const hopCount = Number.isInteger(Number(hops)) && Number(hops) >= 0 ? Number(hops) : 0;
    const hasBody = body !== undefined;
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      host: 'localhost',
      [REMOTE_RELAY_HEADERS.origin]: toText(getOwnRelayId?.()) || 'self',
      [REMOTE_RELAY_HEADERS.hops]: String(hopCount),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    };
    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : defaultTimeoutMs;

    let answer;
    try {
      answer = await inject({
        method: String(method || 'GET').toUpperCase(),
        url: buildUrl(path, query),
        headers,
        body,
        hasBody,
        timeoutMs: effectiveTimeoutMs,
      });
    } catch (error) {
      if (error instanceof RemoteRelayError) throw error;
      throw new RemoteRelayError(
        REMOTE_RELAY_ERROR_CODES.internal,
        `${relayLabel(relay)} failed on its own request: ${toText(error?.message || error).slice(0, 200)}`,
        { detail: 'loopback failure' },
      );
    }

    const status = Number(answer.status) || 0;
    let parsed = null;
    let json = true;
    if (answer.text.trim()) {
      try {
        parsed = JSON.parse(answer.text);
      } catch {
        json = false;
      }
    }
    if (status < 200 || status >= 300) throw remoteRelayHttpError(relay, status, parsed);
    if (!json) {
      throw new RemoteRelayError(
        REMOTE_RELAY_ERROR_CODES.unsupported,
        `${relayLabel(relay)} did not answer its own request with JSON`,
        { status, detail: 'not json' },
      );
    }
    return parsed;
  }

  return { request };
}
