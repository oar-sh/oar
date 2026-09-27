import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApiClient } from "./api-client.mjs";

const TOKEN = "test-token-api-client";
const TOOL_PATH = "/api/remote-relays/tool";

/**
 * A local relay stand-in. `route(req, res, body)` answers; every request is
 * recorded with whether it closed before an answer was written (`dropped`).
 */
async function startServer(route) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null, dropped: false };
      requests.push(entry);
      res.on("close", () => { if (!res.writableEnded) entry.dropped = true; });
      route(req, res, entry.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function answer(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

function client(url) {
  return createApiClient({
    serverUrl: url,
    token: TOKEN,
    getHeaders: () => ({ "X-Relay-Conversation-Id": "conv-1" }),
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a long call waits out headers that come late, over node:http with no timeout on it", async (t) => {
  // The relay sends nothing until the remote answered. fetch (undici) would
  // give up at 300 s; the long call must have no clock at all.
  const server = await startServer((req, res, body) => {
    setTimeout(() => answer(res, 200, { ok: true, status: "done", echo: body }), 1_500);
  });
  t.after(() => server.close());
  const requestSpy = t.mock.method(http, "request");
  const fetchSpy = t.mock.method(globalThis, "fetch");
  let socket = null;

  const pending = client(server.url)("POST", TOOL_PATH, { conversationId: "conv-1", action: "wait" }, { longCall: true });
  assert.equal(requestSpy.mock.callCount(), 1, "the long call goes over node:http");
  const req = requestSpy.mock.calls[0].result;
  req.on("socket", (assigned) => { socket = assigned; });
  const result = await pending;

  assert.deepEqual(result, { ok: true, status: "done", echo: { conversationId: "conv-1", action: "wait" } });
  assert.equal(fetchSpy.mock.callCount(), 0, "never through fetch");
  const options = requestSpy.mock.calls[0].arguments[1];
  assert.equal(options.agent, false, "its own connection: the global agent carries a socket timeout");
  assert.equal("timeout" in options, false);
  assert.equal(req.timeout, undefined, "no request timeout");
  assert.ok(socket, "the request got a socket");
  assert.ok(!socket.timeout, `no socket timeout (got ${socket.timeout})`);

  const [seen] = server.requests;
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(seen.headers["x-relay-conversation-id"], "conv-1");
});

test("short calls keep using fetch", async (t) => {
  const server = await startServer((req, res) => answer(res, 200, { count: 2 }));
  t.after(() => server.close());
  const requestSpy = t.mock.method(http, "request");
  assert.deepEqual(await client(server.url)("GET", "/api/remote-relays/summary"), { count: 2 });
  assert.equal(requestSpy.mock.callCount(), 0);
  assert.equal(server.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test("a long call fails exactly like a short one: status, detail, parsed body, message", async (t) => {
  const locked = { ok: false, code: "REMOTE_RELAY_LOCKED", error: "Ask the user to mention @linux-test first." };
  const server = await startServer((req, res) => {
    if (req.url === "/api/plain") return answer(res, 502, "Bad gateway");
    if (req.url === "/api/empty") return answer(res, 500, "");
    return answer(res, 403, locked);
  });
  t.after(() => server.close());
  const api = client(server.url);

  for (const [path, expected] of [
    [TOOL_PATH, { status: 403, detail: locked.error, body: locked, message: `HTTP 403 ${TOOL_PATH}: ${locked.error}` }],
    ["/api/plain", { status: 502, detail: "Bad gateway", body: null, message: "HTTP 502 /api/plain: Bad gateway" }],
    ["/api/empty", { status: 500, detail: "", body: null, message: "HTTP 500 /api/empty" }],
  ]) {
    for (const longCall of [false, true]) {
      const error = await api("POST", path, {}, { longCall }).then(
        () => assert.fail(`${path} should fail`),
        (failure) => failure,
      );
      assert.deepEqual(
        { status: error.status, detail: error.detail, body: error.body, message: error.message },
        expected,
        `${path} (${longCall ? "long" : "short"} call)`,
      );
    }
  }
});

test("aborting a long call drops the request and rejects with an AbortError", async (t) => {
  // A remote turn that never ends: only the caller's signal can end the call.
  const server = await startServer(() => {});
  t.after(() => server.close());
  const api = client(server.url);
  const controller = new AbortController();

  const pending = api("POST", TOOL_PATH, { action: "send" }, { longCall: true, signal: controller.signal });
  await waitFor(() => server.requests.length === 1, "the request reached the relay");
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  await waitFor(() => server.requests[0].dropped, "the relay saw the request close");
});

test("an already aborted signal never sends", async (t) => {
  const server = await startServer((req, res) => answer(res, 200, { ok: true }));
  t.after(() => server.close());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client(server.url)("POST", TOOL_PATH, {}, { longCall: true, signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.requests.length, 0);
});

test("a long call rejects when the relay is gone or drops the answer halfway", async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
    res.write('{"ok":');
    setTimeout(() => res.socket.destroy(), 20);
  });
  t.after(() => server.close());
  await assert.rejects(client(server.url)("POST", TOOL_PATH, {}, { longCall: true }));

  // Nothing listens there any more.
  const closed = await startServer(() => {});
  await closed.close();
  await assert.rejects(client(closed.url)("POST", TOOL_PATH, {}, { longCall: true }), (error) => error.code === "ECONNREFUSED");
});
