/**
 * A fake of the Claude Cloud session API, for tests/claude-cloud.spec.mjs.
 *
 * An in-process HTTP server on a loopback port that speaks the shapes the
 * cloud client (shared/claude-cloud/api-client.mjs) was written against: the
 * profile and the environments, creating a session, its event log (paged, and
 * as a server-sent event stream with ids and keepalives), posting events into
 * it, archiving it, and the account usage reads. The relay under test and its
 * cloud worker are pointed at it with OAR_CLAUDE_CLOUD_API_BASE_URL, so a turn
 * runs through the real client, worker and relay and never leaves the machine.
 *
 * What a session answers is scripted by the text of the user message:
 *
 *   contains "ask"   an AskUserQuestion permission request; the turn waits for
 *                    the control_response and then names the chosen label
 *   contains "push"  a pushed branch (system/vcs_state_changed), then a reply
 *   contains "slow"  a first line of reply, then nothing: the turn stays open
 *                    until it is interrupted
 *   contains "trailer"  the reply is the attribution line the session's
 *                    commits would end with: the one an `apply_flag_settings`
 *                    control request set, else the sandbox's own
 *   anything else    a sandbox log line and a tool call (two activity lines),
 *                    a reply and a result with a cost
 *
 * An interrupt ends the running turn at once with the result a stopped turn
 * has (`error_during_execution`, `terminal_reason: "aborted_tools"`).
 *
 * An `apply_flag_settings` control request (in the create call before the
 * first message, or posted later) is merged into the session's settings and
 * answered with a `control_response`; a key set to null is taken out again.
 *
 * Every request is recorded (method, path, query, body, and whether it carried
 * the bearer token; never the token itself), and a request without the test
 * token is answered 401. All names and numbers in here are invented.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";

export const FAKE_CLOUD_TOKEN = "test-token-value";
export const FAKE_CLOUD_ORGANIZATION_ID = "0a1b2c3d-0000-4000-8000-00000000e2e0";

export const FAKE_CLOUD_ENVIRONMENTS = Object.freeze([
  Object.freeze({ id: "env_01EXAMPLEaaaaaaaaaaaaaaaa", name: "Default" }),
  Object.freeze({ id: "env_01EXAMPLEbbbbbbbbbbbbbbbb", name: "Heavy builds" }),
]);

export const FAKE_CLOUD_QUESTION = Object.freeze({
  text: "Which colour should the sample banner use?",
  header: "Colour",
  labels: Object.freeze(["Teal", "Amber"]),
});

export const FAKE_CLOUD_PUSHED_BRANCH = "claude/sample-change";
/** What every finished turn of the fake costs, and what the session's total grows by. */
export const FAKE_CLOUD_TURN_COST_USD = 0.42;
export const FAKE_CLOUD_SANDBOX_LINE = "Cloning the repository";
export const FAKE_CLOUD_TOOL_COMMAND = "ls sample-dir";
export const FAKE_CLOUD_SLOW_FIRST_LINE = "Starting the slow sample job.";
/** What the fake sandbox ends a commit with while no attribution setting is in place. */
export const FAKE_CLOUD_OWN_TRAILER = "Co-Authored-By: Sample Sandbox Agent <agent@example.com>";
export const FAKE_CLOUD_NO_TRAILER = "(no attribution line)";

/** The reply of a "trailer" turn for a commit attribution line (as code: it holds an address in angle brackets). */
export function fakeCloudTrailerReplyFor(trailer) {
  return `Commits here end with: \`${trailer}\``;
}

/** The reply of a default turn; the spec looks for this text. */
export function fakeCloudReplyFor(text) {
  return `Fake cloud reply to: ${text}`;
}

/** The account usage body: two windows and one dollar credit. */
export const FAKE_CLOUD_USAGE = Object.freeze({
  five_hour: { utilization: 12, resets_at: "2031-03-04T15:00:00Z", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: 31, resets_at: "2031-03-09T09:00:00Z", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day_opus: null,
  iguana_necktie: {
    utilization: 15, resets_at: "2031-06-01T08:00:00Z", limit_dollars: 50, used_dollars: 7.5, remaining_dollars: 42.5, locked_reason: null,
  },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
});

const INTERRUPTED = Symbol("interrupted");
const SESSION_ROUTE = /^\/v1\/code\/sessions\/([^/]+)(\/events\/stream|\/events|\/archive)?$/;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function messageText(payload) {
  const content = payload?.message?.content;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n");
}

/**
 * `stepDelayMs`: the pause after every event a turn writes, so that a reply
 * arrives over the open stream piece by piece and not as one replayed batch.
 */
export async function startFakeClaudeCloudApi({
  token = FAKE_CLOUD_TOKEN,
  stepDelayMs = 120,
  keepaliveMs = 2_000,
  pageSize = 50,
} = {}) {
  const requests = [];
  const sessions = new Map();
  const sockets = new Set();
  let sessionCounter = 0;
  let idCounter = 0;
  let closed = false;

  const nextId = (prefix) => {
    idCounter += 1;
    return `${prefix}_01EXAMPLE${String(idCounter).padStart(16, "0")}`;
  };

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  function sendError(res, status, type, message) {
    sendJson(res, status, { type: "error", error: { type, message } });
  }

  // ── The event log of a session ──

  // A stream the other side has dropped is written to no more.
  function writeChunk(res, text) {
    if (!res.writableEnded && !res.destroyed) res.write(text);
  }

  function writeFrame(res, event) {
    writeChunk(res, `event: client_event\nid: ${event.sequence_num}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function appendEvent(session, { source, eventType, payload, eventId = null }) {
    const event = {
      event_id: eventId || randomUUID(),
      sequence_num: String(session.events.length + 1),
      event_type: eventType,
      source,
      payload,
      created_at: new Date().toISOString(),
    };
    session.events.push(event);
    for (const res of session.streams) writeFrame(res, event);
    return event;
  }

  // ── Scripted turns ──

  function assistantText(session, text) {
    return {
      type: "assistant",
      uuid: randomUUID(),
      session_id: session.id,
      parent_tool_use_id: null,
      message: { id: nextId("msg"), role: "assistant", model: session.model, content: [{ type: "text", text }] },
    };
  }

  function successResult(session, text) {
    session.costUsd = Math.round((session.costUsd + FAKE_CLOUD_TURN_COST_USD) * 100) / 100;
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      num_turns: 1,
      duration_ms: 1200,
      total_cost_usd: FAKE_CLOUD_TURN_COST_USD,
      stop_reason: "end_turn",
      terminal_reason: "completed",
      session_id: session.id,
      uuid: randomUUID(),
      modelUsage: {
        [session.model]: {
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: FAKE_CLOUD_TURN_COST_USD,
          contextWindow: 200000,
        },
      },
    };
  }

  async function runScript(session, turn, text) {
    const emit = async (payload) => {
      if (turn.interrupted) throw INTERRUPTED;
      appendEvent(session, { source: "worker", eventType: payload.type, payload });
      await Promise.race([sleep(stepDelayMs), turn.interruption]);
      if (turn.interrupted) throw INTERRUPTED;
    };

    await emit({ type: "system", subtype: "init", model: session.model, session_id: session.id, cwd: "/home/user/sample-repo" });

    if (/\bask\b/i.test(text)) {
      const requestId = nextId("req");
      const input = {
        questions: [{
          question: FAKE_CLOUD_QUESTION.text,
          header: FAKE_CLOUD_QUESTION.header,
          options: FAKE_CLOUD_QUESTION.labels.map((label) => ({ label, description: `Use ${label.toLowerCase()}.` })),
          multiSelect: false,
        }],
      };
      const answered = new Promise((resolve) => { turn.waiting.set(requestId, resolve); });
      await emit({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          display_name: "AskUserQuestion",
          input,
          tool_use_id: nextId("toolu"),
          requires_user_interaction: true,
        },
      });
      const decision = await Promise.race([answered, turn.interruption]);
      if (turn.interrupted) throw INTERRUPTED;
      const answer = decision?.behavior === "allow"
        ? String(decision?.updatedInput?.answers?.[FAKE_CLOUD_QUESTION.text] || "")
        : "";
      const reply = answer ? `You chose ${answer}.` : "The question was not answered.";
      await emit(assistantText(session, reply));
      await emit(successResult(session, reply));
      return;
    }

    if (/\bpush\b/i.test(text)) {
      await emit({ type: "system", subtype: "vcs_state_changed", branch: FAKE_CLOUD_PUSHED_BRANCH, kind: "push", session_id: session.id });
      const reply = `Pushed ${FAKE_CLOUD_PUSHED_BRANCH}.`;
      await emit(assistantText(session, reply));
      await emit(successResult(session, reply));
      return;
    }

    if (/\btrailer\b/i.test(text)) {
      const attribution = session.flagSettings.attribution;
      const trailer = attribution && typeof attribution === "object"
        ? (String(attribution.commit || "") || FAKE_CLOUD_NO_TRAILER)
        : FAKE_CLOUD_OWN_TRAILER;
      const reply = fakeCloudTrailerReplyFor(trailer);
      await emit(assistantText(session, reply));
      await emit(successResult(session, reply));
      return;
    }

    if (/\bslow\b/i.test(text)) {
      await emit(assistantText(session, FAKE_CLOUD_SLOW_FIRST_LINE));
      await turn.interruption;
      throw INTERRUPTED;
    }

    const toolUseId = nextId("toolu");
    await emit({
      type: "env_manager_log",
      data: { content: FAKE_CLOUD_SANDBOX_LINE, level: "info", extra: { step: "clone", step_status: "started" } },
    });
    await emit({
      type: "assistant",
      uuid: randomUUID(),
      session_id: session.id,
      parent_tool_use_id: null,
      message: {
        id: nextId("msg"),
        role: "assistant",
        model: session.model,
        content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: FAKE_CLOUD_TOOL_COMMAND, description: "List the sample files" } }],
      },
    });
    await emit({
      type: "user",
      uuid: randomUUID(),
      session_id: session.id,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "sample.txt", is_error: false }] },
    });
    const reply = fakeCloudReplyFor(text);
    await emit(assistantText(session, reply));
    await emit(successResult(session, reply));
  }

  /** One turn per user message, one after the other, as the cloud queues them. */
  function startNextTurn(session) {
    if (closed || session.turn || !session.queue.length) return;
    const text = session.queue.shift();
    let interrupt = null;
    const turn = {
      interrupted: false,
      waiting: new Map(),
      interruption: new Promise((resolve) => { interrupt = resolve; }),
      interrupt: () => {
        turn.interrupted = true;
        interrupt();
      },
    };
    session.turn = turn;
    session.workerStatus = "running";
    runScript(session, turn, text)
      .catch((error) => {
        if (error !== INTERRUPTED) throw error;
        appendEvent(session, {
          source: "worker",
          eventType: "result",
          payload: {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            num_turns: 1,
            duration_ms: 800,
            total_cost_usd: 0,
            terminal_reason: "aborted_tools",
            session_id: session.id,
            uuid: randomUUID(),
          },
        });
      })
      .catch(() => {})
      .finally(() => {
        session.turn = null;
        session.workerStatus = "idle";
        startNextTurn(session);
      });
  }

  /** A user message arrives: logged once per uuid, then answered as a turn. */
  function acceptUserMessage(session, payload) {
    const uuid = String(payload?.uuid || "").trim();
    const known = uuid ? session.events.find((event) => event.event_type === "user" && event.payload?.uuid === uuid) : null;
    if (known) return { event: known, duplicate: true };
    const event = appendEvent(session, {
      source: "client",
      eventType: "user",
      payload: { ...payload, session_id: session.id },
      eventId: uuid || null,
    });
    session.queue.push(messageText(payload));
    startNextTurn(session);
    return { event, duplicate: false };
  }

  /** Settings for the sandbox's agent: logged, merged (null removes a key), answered. */
  function acceptFlagSettings(session, payload) {
    const event = appendEvent(session, { source: "client", eventType: "control_request", payload });
    const settings = payload?.request?.settings && typeof payload.request.settings === "object" ? payload.request.settings : {};
    for (const [key, value] of Object.entries(settings)) {
      if (value === null) delete session.flagSettings[key];
      else session.flagSettings[key] = value;
    }
    appendEvent(session, {
      source: "worker",
      eventType: "control_response",
      payload: {
        type: "control_response",
        uuid: randomUUID(),
        response: { subtype: "success", request_id: String(payload?.request_id || "") },
      },
    });
    return event;
  }

  const isFlagSettingsRequest = (payload) => payload?.type === "control_request"
    && payload?.request?.subtype === "apply_flag_settings";

  // ── Routes ──

  function createSession(res, body) {
    const initial = (Array.isArray(body?.events) ? body.events : []).map((event) => event?.payload);
    const first = initial.find((payload) => payload?.type === "user") || null;
    const source = Array.isArray(body?.config?.sources) ? body.config.sources[0] : null;
    if (!body?.environment_id || !body?.config?.model || source?.type !== "git_repository" || !source?.url || !first) {
      return sendError(res, 400, "invalid_request_error", "environment_id, config.model, a git_repository source and a first event are required");
    }
    if (!FAKE_CLOUD_ENVIRONMENTS.some((environment) => environment.id === body.environment_id)) {
      return sendError(res, 404, "not_found_error", "environment_not_found");
    }
    const uuid = String(first.uuid || "").trim();
    const existing = uuid ? [...sessions.values()].find((session) => session.firstUuid === uuid) : null;
    if (existing) return sendJson(res, 200, { deduplicated: true, session: describeSession(existing) });

    sessionCounter += 1;
    const id = `cse_01EXAMPLE${String(sessionCounter).padStart(16, "a")}`;
    const session = {
      id,
      firstUuid: uuid,
      title: String(body.title || ""),
      environmentId: body.environment_id,
      model: String(body.config.model),
      source: { url: String(source.url), revision: source.revision ?? null },
      status: "active",
      workerStatus: "idle",
      costUsd: 0,
      events: [],
      streams: new Set(),
      queue: [],
      turn: null,
      flagSettings: {},
    };
    sessions.set(id, session);
    // The first event of a real session is the client's own permission-mode
    // request; the worker has to ignore it.
    appendEvent(session, {
      source: "client",
      eventType: "control_request",
      payload: { type: "control_request", request_id: nextId("req"), request: { subtype: "set_permission_mode", mode: "auto" } },
    });
    for (const payload of initial) {
      if (isFlagSettingsRequest(payload)) acceptFlagSettings(session, payload);
    }
    acceptUserMessage(session, first);
    return sendJson(res, 200, { deduplicated: false, session: describeSession(session) });
  }

  function describeSession(session) {
    return {
      id: session.id,
      session_url: `https://claude.ai/code/${session.id}`,
      title: session.title,
      status: session.status,
      environment_id: session.environmentId,
    };
  }

  function getSession(res, session) {
    return sendJson(res, 200, {
      response_shape: {
        ...describeSession(session),
        worker_status: session.workerStatus,
        external_metadata: {
          context_usage: { used_tokens: 15400, max_tokens: 200000 },
          usage: { cost_usd: session.costUsd, input_tokens: 1200, output_tokens: 340, cache_read_tokens: 0, cache_write_tokens: 0 },
          current_branches: { "": session.source.revision || "main" },
          rate_limit_info: null,
          last_served_model: session.model,
        },
      },
    });
  }

  function listEvents(res, session, query) {
    const cursor = Number(query.get("cursor") || 0) || 0;
    const limit = Math.max(1, Number(query.get("limit") || 0) || pageSize);
    const descending = query.get("sort_order") === "desc";
    const after = session.events.filter((event) => Number(event.sequence_num) > cursor);
    const ordered = descending ? [...after].reverse() : after;
    const page = ordered.slice(0, limit);
    return sendJson(res, 200, {
      data: page,
      next_cursor: ordered.length > page.length ? page[page.length - 1].sequence_num : null,
    });
  }

  function streamEvents(req, res, session) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(":keepalive\n\n");
    res.write(`event: session_update\ndata: ${JSON.stringify({ connection_status: "connected" })}\n\n`);
    const after = Number(req.headers["last-event-id"] || 0) || 0;
    for (const event of session.events) {
      if (Number(event.sequence_num) > after) writeFrame(res, event);
    }
    session.streams.add(res);
    const keepalive = setInterval(() => writeChunk(res, ":keepalive\n\n"), keepaliveMs);
    keepalive.unref?.();
    res.on("close", () => {
      clearInterval(keepalive);
      session.streams.delete(res);
    });
  }

  function postEvents(res, session, body) {
    const events = Array.isArray(body?.events) ? body.events : [];
    if (!events.length || events.some((event) => !event?.event_type || !event?.payload)) {
      return sendError(res, 400, "invalid_request_error", "events[].event_type and events[].payload are required");
    }
    if (session.status === "archived") return sendError(res, 409, "invalid_request_error", "session is archived");
    const results = [];
    for (const { event_type: eventType, payload } of events) {
      if (eventType === "user") {
        const { event, duplicate } = acceptUserMessage(session, payload);
        results.push({ event_id: event.event_id, sequence_num: event.sequence_num, duplicate });
        continue;
      }
      if (eventType === "control_request" && isFlagSettingsRequest(payload)) {
        const event = acceptFlagSettings(session, payload);
        results.push({ event_id: event.event_id, sequence_num: event.sequence_num, duplicate: false });
        continue;
      }
      const event = appendEvent(session, { source: "client", eventType, payload });
      results.push({ event_id: event.event_id, sequence_num: event.sequence_num, duplicate: false });
      if (eventType === "control_response") {
        const requestId = String(payload?.response?.request_id || "");
        const resolve = session.turn?.waiting.get(requestId);
        session.turn?.waiting.delete(requestId);
        resolve?.(payload?.response?.response || null);
      } else if (eventType === "control_request" && payload?.request?.subtype === "interrupt") {
        session.turn?.interrupt();
      }
    }
    return sendJson(res, 200, { results });
  }

  function route(req, res, url, body) {
    const { pathname } = url;
    if (req.method === "GET" && pathname === "/api/oauth/profile") {
      return sendJson(res, 200, {
        account: { uuid: "0a1b2c3d-0000-4000-8000-00000000acc0", email: "dev@example.com", display_name: "Dev" },
        organization: { uuid: FAKE_CLOUD_ORGANIZATION_ID, name: "Example Org" },
      });
    }
    if (req.method === "GET" && pathname === "/v1/environment_providers") {
      if (req.headers["x-organization-uuid"] !== FAKE_CLOUD_ORGANIZATION_ID) {
        return sendError(res, 400, "invalid_request_error", "x-organization-uuid is required");
      }
      return sendJson(res, 200, {
        environments: FAKE_CLOUD_ENVIRONMENTS.map((environment) => ({
          kind: "anthropic_cloud",
          environment_id: environment.id,
          name: environment.name,
          state: "active",
          created_at: "2031-01-02T03:04:05Z",
        })),
        has_more: false,
      });
    }
    if (req.method === "GET" && pathname === "/api/oauth/usage") return sendJson(res, 200, FAKE_CLOUD_USAGE);
    const organizationPrefix = `/api/oauth/organizations/${FAKE_CLOUD_ORGANIZATION_ID}`;
    if (req.method === "GET" && pathname === `${organizationPrefix}/prepaid/credits`) {
      return sendJson(res, 200, { amount: 0, currency: "USD", auto_reload_settings: null });
    }
    if (req.method === "GET" && pathname === `${organizationPrefix}/overage_credit_grant`) {
      return sendJson(res, 200, { available: false, eligible: false, granted: true, amount_minor_units: 5000, currency: "USD" });
    }
    if (req.method === "POST" && pathname === "/v1/code/sessions") return createSession(res, body);

    const match = pathname.match(SESSION_ROUTE);
    if (match) {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) return sendError(res, 404, "not_found_error", "session not found");
      const suffix = match[2] || "";
      if (req.method === "GET" && !suffix) return getSession(res, session);
      if (req.method === "GET" && suffix === "/events") return listEvents(res, session, url.searchParams);
      if (req.method === "GET" && suffix === "/events/stream") return streamEvents(req, res, session);
      if (req.method === "POST" && suffix === "/events") return postEvents(res, session, body);
      if (req.method === "POST" && suffix === "/archive") {
        if (session.status === "archived") return sendError(res, 409, "invalid_request_error", "session is already archived");
        session.status = "archived";
        session.turn?.interrupt();
        return sendJson(res, 200, {});
      }
    }
    return sendError(res, 404, "not_found_error", `no route for ${req.method} ${pathname}`);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const authorization = String(req.headers.authorization || "");
      const authorized = authorization === `Bearer ${token}`;
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        hasAuthorization: authorization.length > 0,
        authorized,
        at: Date.now(),
      });
      if (!authorized) return sendError(res, 401, "authentication_error", "invalid bearer token");
      try {
        return route(req, res, url, body);
      } catch (error) {
        return sendError(res, 500, "api_error", String(error?.message || error));
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    /** Every request so far, oldest first. */
    requests,
    /** The recorded requests with this method whose path is `path` (a string) or matches it (a RegExp). */
    requestsTo(method, path) {
      return requests.filter((request) => request.method === method
        && (path instanceof RegExp ? path.test(request.path) : request.path === path));
    },
    /** The events of `eventType` that clients posted into any session, as `{ sessionId, payload }`. */
    postedEvents(eventType) {
      return requests
        .filter((request) => request.method === "POST" && /^\/v1\/code\/sessions\/[^/]+\/events$/.test(request.path))
        .flatMap((request) => (Array.isArray(request.body?.events) ? request.body.events : [])
          .filter((event) => event?.event_type === eventType)
          .map((event) => ({ sessionId: decodeURIComponent(request.path.split("/")[4]), payload: event.payload })));
    },
    /** The sessions created so far: `{ id, status, workerStatus, model, source, title, environmentId, costUsd }`. */
    sessions() {
      return [...sessions.values()].map((session) => ({
        id: session.id,
        status: session.status,
        workerStatus: session.workerStatus,
        model: session.model,
        source: { ...session.source },
        title: session.title,
        environmentId: session.environmentId,
        costUsd: session.costUsd,
      }));
    },
    async stop() {
      closed = true;
      for (const session of sessions.values()) {
        const streams = [...session.streams];
        session.streams.clear();
        session.queue.length = 0;
        session.turn?.interrupt();
        for (const res of streams) res.end();
      }
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
