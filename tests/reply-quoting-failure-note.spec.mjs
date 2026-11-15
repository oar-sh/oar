import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";
import { respondAsWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

// An agent that reports on a failed test quotes the failure note. Its reply is
// a reply: stored whole, its turn done. A failure that a sender reports as
// text alone is still a failure, and its text is kept whole as well.

// Made as the web client makes a chat: bound from the start, so it takes a
// next message.
async function queueAndDequeue(text) {
  const { conversationId, messageId, worker } = await startConversation({ text });
  await worker.take(messageId);
  return { conversationId, messageId };
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
  const { conversationId, messageId } = await queueAndDequeue(`Report please ${stamp}`);
  try {
    const answered = await respondAsWorker(messageId, { conversationId, text: report, model: "gpt-5.4-mini", mode: "agent" });
    expect(answered.ok).toBeTruthy();
    const reply = await storedReply(request, headers, conversationId, messageId);
    expect(reply.text).toBe(report);
    // Its own turn is over (other specs' turns on this relay are not its business).
    const detail = await (await request.get(`/api/conversation/${conversationId}?limit=5`, { headers })).json();
    expect(detail.sessionState).toBe("idle");
    // The next message is an ordinary one: the turn before it did not fail.
    const next = await request.post("/api/message", {
      headers,
      data: { conversationId, text: `And the next one ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(next.status()).toBe(200);
  } finally {
    await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});

test("a failure reported as text alone stays a failure, with its text whole", async ({ request }) => {
  const headers = { Authorization: `Bearer ${relayToken()}` };
  const stamp = Date.now();
  const note = "No tool output was returned for a required function call. Error code: relay.missing-tool-output. "
    + `IDs: functionCallId=call_lantern${stamp}. Retry the message. Details: no tool output found for function call call_lantern${stamp}`;
  const { conversationId, messageId } = await queueAndDequeue(`Fail please ${stamp}`);
  try {
    const answered = await respondAsWorker(messageId, { conversationId, text: note, model: "gpt-5.4-mini", mode: "agent" });
    expect(answered.ok).toBeTruthy();
    const reply = await storedReply(request, headers, conversationId, messageId);
    expect(reply.text).toBe(note);
  } finally {
    await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});
