/**
 * A fake of the Anthropic API, for the Claude API provider's tests.
 *
 * An in-process HTTP server on a loopback port that answers `GET /v1/models`
 * the way the relay's model discovery (shared/anthropic-api.mjs) reads it:
 * paged with `has_more` / `last_id` / `after_id`, each model with its context
 * window, output limit and capabilities. The relay under test is pointed at it
 * with OAR_ANTHROPIC_API_BASE_URL, which it takes for a loopback address only.
 *
 * It also holds the refusals the docs describe (docs/providers.md,
 * docs/troubleshooting.md), in the shape Anthropic sends them:
 * `{ type: "error", error: { type, message } }` with the HTTP status. A key
 * named in `refusingKeys` gets its refusal from `/v1/models`; the same shapes
 * are exported for tests that feed them to the failure reading of a turn
 * (describeClaudeApiFailure), which sees them as Claude Code quotes them
 * (`fakeAnthropicCliErrorText`).
 *
 * Every request is recorded (path, `after_id`, the key and the API version it
 * carried). A key the fake does not know is answered 401. The keys are
 * invented: they carry the Console prefix the Claude API tab requires and stay
 * too short to read as a real key (scripts/hygiene-patterns.mjs). The model
 * names, numbers and messages are samples, not a copy of Anthropic's list.
 */

import http from "node:http";

export const FAKE_ANTHROPIC_KEY = "sk-ant-api03-e2e-0000";
export const FAKE_ANTHROPIC_SECOND_KEY = "sk-ant-api03-e2e-1111";
export const FAKE_ANTHROPIC_API_VERSION = "2023-06-01";

const ALL_EFFORT = Object.freeze({
  supported: true,
  low: { supported: true },
  medium: { supported: true },
  high: { supported: true },
  xhigh: { supported: true },
  max: { supported: true },
});

// GET /v1/models, two pages: has_more / last_id are followed.
export const FAKE_ANTHROPIC_MODEL_PAGES = Object.freeze([
  Object.freeze({
    data: [
      { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", max_input_tokens: 1000000, max_tokens: 64000, capabilities: { image_input: { supported: true }, effort: ALL_EFFORT } },
      { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } } },
    ],
    has_more: true,
    last_id: "claude-opus-5-5",
  }),
  Object.freeze({
    data: [
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: { supported: false } } },
    ],
    has_more: false,
    last_id: "claude-haiku-4-5-20251001",
  }),
]);

function refusal(status, type, message, details = null) {
  return Object.freeze({
    status,
    body: Object.freeze({ type: "error", error: Object.freeze({ type, message, ...(details ? { details } : {}) }) }),
  });
}

/**
 * The refusals, by name. `failure` is the code the relay gives a turn that
 * ends on it (claude-api-backend.mjs, describeClaudeApiFailure), or null when
 * it has no advice of its own; `discovery` is the code model discovery throws
 * (shared/anthropic-api.mjs).
 */
export const FAKE_ANTHROPIC_REFUSALS = Object.freeze({
  // A key Anthropic does not know, or one that was revoked.
  invalidKey: Object.freeze({ ...refusal(401, "authentication_error", "invalid x-api-key"), failure: "claude-api-key", discovery: "unauthorized" }),
  // A key without the permission for the call.
  forbidden: Object.freeze({ ...refusal(403, "permission_error", "Your API key does not have permission to use the specified resource."), failure: "claude-api-key", discovery: "forbidden" }),
  // A billing problem other than the balance (the payment details).
  billing: Object.freeze({ ...refusal(402, "billing_error", "There is an issue with your billing."), failure: "claude-api-billing", discovery: "billing" }),
  // The prepaid credit is used up: a 400, read by its text.
  creditTooLow: Object.freeze({ ...refusal(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), failure: "claude-api-credit", discovery: "error" }),
  // A workspace spend limit set in the Console: a 400, read by its text.
  workspaceSpendLimit: Object.freeze({ ...refusal(400, "invalid_request_error", "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."), failure: "claude-api-spend-limit", discovery: "error" }),
  // The organisation's tier spend cap: a 429 that is not a rate limit.
  enforcedSpendLimit: Object.freeze({ ...refusal(429, "rate_limit_error", "Your organization has reached its monthly spend limit.", { error_code: "enforced_spend_limit_reached" }), failure: "claude-api-spend-limit", discovery: "rate_limited" }),
  rateLimit: Object.freeze({ ...refusal(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit."), failure: "claude-api-rate-limit", discovery: "rate_limited" }),
  overloaded: Object.freeze({ ...refusal(529, "overloaded_error", "Overloaded"), failure: "claude-api-rate-limit", discovery: "transient" }),
  // A key that is not tied to a workspace. The relay has no advice of its own
  // for it yet (docs/troubleshooting.md has the way round it).
  noWorkspace: Object.freeze({ ...refusal(400, "invalid_request_error", "This API key is not tied to a workspace. Create the key inside a workspace."), failure: null, discovery: "error" }),
});

/** A refusal as Claude Code quotes it in a failed turn's error text. */
export function fakeAnthropicCliErrorText(name) {
  const entry = FAKE_ANTHROPIC_REFUSALS[name];
  if (!entry) throw new Error(`No fake Anthropic refusal named ${name}`);
  return `API Error: ${entry.status} ${JSON.stringify(entry.body)}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Starts the fake. `keys` are the keys it answers; `refusingKeys` maps a key
 * to the name of the refusal `/v1/models` gives it; `pages` replaces the
 * model list. Resolves `{ server, seen, baseUrl, close() }`.
 */
export function startFakeAnthropicApi({
  keys = [FAKE_ANTHROPIC_KEY, FAKE_ANTHROPIC_SECOND_KEY],
  refusingKeys = {},
  pages = FAKE_ANTHROPIC_MODEL_PAGES,
} = {}) {
  const seen = [];
  const known = new Set(keys);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const key = String(req.headers["x-api-key"] || "");
    seen.push({
      path: url.pathname,
      afterId: url.searchParams.get("after_id"),
      key,
      version: req.headers["anthropic-version"] || "",
    });
    if (req.method !== "GET" || url.pathname !== "/v1/models") {
      sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
      return;
    }
    const refusalName = Object.hasOwn(refusingKeys, key) ? refusingKeys[key] : (known.has(key) ? null : "invalidKey");
    if (refusalName) {
      const entry = FAKE_ANTHROPIC_REFUSALS[refusalName];
      sendJson(res, entry.status, entry.body);
      return;
    }
    const afterId = url.searchParams.get("after_id");
    const index = afterId ? pages.findIndex((page) => page.last_id === afterId) + 1 : 0;
    const page = pages[index] || { data: [], has_more: false, last_id: null };
    sendJson(res, 200, page);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      seen,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => {
        server.closeAllConnections?.();
        return new Promise((done) => server.close(done));
      },
    }));
  });
}
