import test from "node:test";
import assert from "node:assert/strict";

import { createPreviewInstructionsProvider, createRelayPromptBuilder } from "./prompt-context.mjs";
import { PREVIEW_TOOL_DESCRIPTION } from "../../../../shared/preview-tool-core.mjs";

const TOOL_INSTRUCTIONS = [
  "# Relay Tool Guidance",
  "",
  "Ask questions through the relay.",
  "",
  "## Preview servers",
  "",
  "Hand-written body that the generated block owns.",
].join("\n");

function createFakeApi(response) {
  const calls = [];
  const api = async (method, routePath) => {
    calls.push(`${method} ${routePath}`);
    return response;
  };
  api.calls = calls;
  return api;
}

test("the first turn carries the guidance with the generated preview block", async () => {
  const api = createFakeApi({ enabled: true, publicBaseUrl: "https://previews.example.test" });
  const build = createRelayPromptBuilder({
    toolInstructions: TOOL_INSTRUCTIONS,
    getPreviewInstructions: createPreviewInstructionsProvider({ api }),
  });

  const prompt = await build({ text: "ship it", relayMode: "agent" });
  assert.ok(prompt.startsWith("[Relay mode: agent]"));
  assert.ok(prompt.includes("Ask questions through the relay."));
  assert.ok(prompt.includes(PREVIEW_TOOL_DESCRIPTION));
  assert.ok(prompt.includes("https://previews.example.test"));
  assert.ok(!prompt.includes("Hand-written body"));
  assert.ok(prompt.endsWith("ship it"));
});

test("a disabled preview lane leaves no preview guidance in the prompt", async () => {
  const api = createFakeApi({ enabled: false, publicBaseUrl: "" });
  const build = createRelayPromptBuilder({
    toolInstructions: TOOL_INSTRUCTIONS,
    getPreviewInstructions: createPreviewInstructionsProvider({ api }),
  });

  const prompt = await build({ text: "ship it", relayMode: "agent" });
  assert.ok(prompt.includes("Ask questions through the relay."));
  assert.ok(!prompt.includes("Preview servers"));
  assert.ok(!prompt.includes(PREVIEW_TOOL_DESCRIPTION));
});

test("guidance repeats only when the relay mode changes, and the lane is looked up once", async () => {
  const api = createFakeApi({ enabled: true, publicBaseUrl: "https://previews.example.test" });
  const build = createRelayPromptBuilder({
    toolInstructions: TOOL_INSTRUCTIONS,
    getPreviewInstructions: createPreviewInstructionsProvider({ api }),
  });

  const first = await build({ text: "one", relayMode: "agent" });
  const second = await build({ text: "two", relayMode: "agent" });
  const third = await build({ text: "three", relayMode: "plan" });

  assert.ok(first.includes(PREVIEW_TOOL_DESCRIPTION));
  assert.ok(!second.includes(PREVIEW_TOOL_DESCRIPTION));
  assert.equal(second, "[Relay mode: agent] two");
  assert.ok(third.includes(PREVIEW_TOOL_DESCRIPTION));
  assert.deepEqual(api.calls, ["GET /api/previews"]);
});

test("a preview lookup failure costs the block, not the turn", async () => {
  const build = createRelayPromptBuilder({
    toolInstructions: TOOL_INSTRUCTIONS,
    getPreviewInstructions: async () => { throw new Error("HTTP 500 /api/previews"); },
  });

  const prompt = await build({ text: "ship it", relayMode: "agent" });
  assert.ok(prompt.includes("Ask questions through the relay."));
  assert.ok(!prompt.includes("Preview servers"));
  assert.ok(prompt.endsWith("ship it"));
});

test("without a preview provider the guidance is passed through unchanged", async () => {
  const build = createRelayPromptBuilder({ toolInstructions: "Guidance only." });
  const prompt = await build({ text: "ship it", relayMode: "agent" });
  assert.ok(prompt.includes("Guidance only."));
});
