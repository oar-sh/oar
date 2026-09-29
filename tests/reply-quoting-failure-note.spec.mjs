import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// An agent that reports on a failed test quotes the failure note. Its reply is
// a reply: stored whole, its turn done. A failure that a sender reports as
// text alone is still a failure, and its text is kept whole as well.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueAndDequeue(request, headers, text) {
  const queued = await request.post("/api/message", { headers, data: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const messageId = String(body?.messageId || "");
  const owner = String(body?.ownerSessionId || "");
  const dequeueHeaders = owner ? { ...headers, "x-relay-session-id": owner } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return { conversationId: String(body?.conversationId || ""), messageId };
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

async function storedReply(request, headers, conversationId, messageId) {
  const got = await request.get(`/api/conversation/${conversationId}`, { headers });
  const messages = (await got.json())?.messages || [];
  return messages.find((message) => message.role === "assistant" && String(message.sourceMessageId || "") === messageId) || null;
}

test("a reply that quotes a failure note is stored whole, and its turn is done", async ({ request }) => {
  const headers = { Authorization: `Bearer ${relayToken()}` };
  const stamp = Date.now();
  const report = [
    `# Report on the lantern survey ${stamp}`,
    "",
    "| Test | Observed | Result |",
    "|---|---|---|",
    '| d. Failure note | The note read: "The turn failed. Error code: relay.copilot-turn-error. Send the message again to retry." | pass |',
    "| e. Harbour ledger | every page checked | pass |",
    "",
    "## Afterwards",
    "",
    "Everything below the quoted note belongs to the reply as well, down to this last line.",
  ].join("\n");
  const { conversationId, messageId } = await queueAndDequeue(request, headers, `Report please ${stamp}`);
  try {
    const answered = await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: report, model: "gpt-5.4-mini", mode: "agent" },
    });
    expect(answered.ok()).toBeTruthy();
    const reply = await storedReply(request, headers, conversationId, messageId);
    expect(reply.text).toBe(report);
    const status = await (await request.get("/api/status", { headers })).json();
    expect(Number(status.processingCount || 0)).toBe(0);
    // The next message is an ordinary one: the turn before it did not fail.
    const next = await request.post("/api/message", {
      headers,
      data: { conversationId, text: `And the next one ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect([200, 409]).toContain(next.status());
  } finally {
    await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});

test("a failure reported as text alone stays a failure, with its text whole", async ({ request }) => {
  const headers = { Authorization: `Bearer ${relayToken()}` };
  const stamp = Date.now();
  const note = "No tool output was returned for a required function call. Error code: relay.missing-tool-output. "
    + `IDs: functionCallId=call_lantern${stamp}. Retry the message. Details: no tool output found for function call call_lantern${stamp}`;
  const { conversationId, messageId } = await queueAndDequeue(request, headers, `Fail please ${stamp}`);
  try {
    const answered = await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: note, model: "gpt-5.4-mini", mode: "agent" },
    });
    expect(answered.ok()).toBeTruthy();
    const reply = await storedReply(request, headers, conversationId, messageId);
    expect(reply.text).toBe(note);
  } finally {
    await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});
