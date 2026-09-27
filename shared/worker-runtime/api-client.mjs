import http from "node:http";
import https from "node:https";

// The error a non-2xx answer throws, the same for both transports:
// `HTTP <status> <path>: <detail>`, with `status`, `detail` and `body`.
function httpError(status, routePath, text) {
  const rawText = String(text || "").trim();
  let detail = rawText;
  let payload = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
      detail = String(payload?.error || payload?.message || rawText).trim();
    } catch {
      detail = rawText;
    }
  }
  const error = new Error(`HTTP ${status} ${routePath}${detail ? `: ${detail}` : ""}`);
  error.status = status;
  error.detail = detail;
  // The parsed error body, for callers that pass the relay's answer on as
  // is (a refused remote_relay call carries its code there).
  error.body = payload && typeof payload === "object" ? payload : null;
  return error;
}

function abortError(signal) {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

/**
 * One request over node:http(s) with no clock on it at all. Global fetch
 * (undici) gives up when no response headers arrive within 300 s, and a
 * long call's route sends nothing until it has its answer: a remote turn of
 * up to 600 s, or an approval card that may sit for hours. So: its own
 * connection (`agent: false` — the global agent carries a socket timeout),
 * no request timeout, no body timeout. Only `signal` ends it early; the
 * relay notices the closed request and stops waiting on its side too.
 */
function requestWithoutTimeout({ url, method, headers, payload, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    let settled = false;
    let req = null;
    const onAbort = () => {
      const error = abortError(signal);
      finish(error);
      req?.destroy(error);
    };
    function finish(error, value) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    }
    req = transport.request(target, {
      method,
      agent: false,
      headers: {
        ...headers,
        ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => finish(null, { status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (error) => finish(error));
      res.on("close", () => {
        if (!res.complete) finish(new Error(`The relay closed the connection mid-answer (${url})`));
      });
    });
    req.on("error", (error) => finish(error));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function createApiClient({ serverUrl, token, getHeaders }) {
  /**
   * `options.longCall`: a call the relay may legitimately hold open for many
   * minutes (the remote_relay tool) — it goes over node:http without any
   * timeout instead of fetch. `options.signal` aborts either kind; an aborted
   * call rejects with an AbortError.
   */
  return async function api(method, routePath, body, { longCall = false, signal = null } = {}) {
    const url = `${serverUrl}${routePath}`;
    const extraHeaders = typeof getHeaders === "function" ? (getHeaders() || {}) : {};
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    };
    const payload = method !== "GET" ? JSON.stringify(body || {}) : undefined;

    if (longCall) {
      const res = await requestWithoutTimeout({ url, method, headers, payload, signal });
      if (res.status < 200 || res.status > 299) throw httpError(res.status, routePath, res.text);
      return JSON.parse(res.text);
    }

    const opts = {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      ...(signal ? { signal } : {}),
    };
    const res = await fetch(url, opts);
    if (!res.ok) {
      throw httpError(res.status, routePath, await res.text().catch(() => ""));
    }
    return res.json();
  };
}
