import { test } from "node:test";
import assert from "node:assert/strict";

import { createQuestionBridge } from "./question-bridge.mjs";

function makeBridge(posts) {
  const api = async (method, path, body) => {
    if (method === "POST" && path === "/api/relay-question") {
      posts.push(body);
      return { question: { id: `q-${posts.length}` } };
    }
    return { question: { status: "answered", answer: "A" } };
  };
  return createQuestionBridge({
    api,
    dbg: () => {},
    sleep: async () => {},
    questionWaitTimeoutMs: 1000,
    questionPollMs: 1,
    getActiveMessage: () => ({ id: "m-1", conversationId: "c-1", relayMode: "agent" }),
    extractQuestionPrompt: (request) => request.question,
    extractQuestionChoices: (request) => request.choices || [],
    serializeRequest: (request) => request,
  });
}

// The relay refuses typed text on a card sent with allowFreeform:false and
// draws no reply box on it, so only a request that says so may close a card.
// The runtime's ask_user takes free text unless told otherwise.
test("a choice question takes typed text unless the request says it does not", async () => {
  const posts = [];
  const bridge = makeBridge(posts);
  await bridge.forwardRelayQuestion({ question: "Which one?", choices: ["A", "B"] });
  await bridge.forwardRelayQuestion({ question: "Which one?", choices: ["A", "B"], allowFreeform: false });
  await bridge.forwardRelayQuestion({ question: "Which one?", choices: ["A", "B"], allow_freeform: true });
  await bridge.forwardRelayQuestion({ question: "Your name?" });
  assert.deepEqual(posts.map((post) => post.allowFreeform), [true, false, true, true]);
});
