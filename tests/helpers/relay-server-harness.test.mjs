import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createRedactingLineWriter, redactRelayLog } from "../relay-server-harness.mjs";

// The e2e relay log is kept on a failure: no credential may reach it, however
// the relay's output is cut into chunks. Every value is made at run time and
// only ever asserted absent, never printed.

const token = crypto.randomUUID();
const sessionKey = `oark1_${crypto.randomBytes(24).toString("base64url")}`;
const signInCode = `oarc1_${crypto.randomBytes(32).toString("base64url")}`;
const capability = `fc1.bs_${crypto.randomBytes(6).toString("hex")}.1799999999.${crypto.randomBytes(16).toString("base64url")}`;

function written() {
  const parts = [];
  return { parts, write: (text) => parts.push(text), text: () => parts.join("") };
}

test("a secret split across two chunks is written redacted, never in pieces", () => {
  for (const secret of [token, sessionKey, signInCode, capability]) {
    for (const at of [1, 5, Math.floor(secret.length / 2), secret.length - 1]) {
      const out = written();
      const writer = createRedactingLineWriter(out.write, [token]);
      const line = `[auth] value ${secret} done\n`;
      const split = line.indexOf(secret) + at;
      writer.push(line.slice(0, split));
      assert.equal(out.text(), "", "the partial line is held");
      writer.push(line.slice(split));
      const text = out.text();
      assert.ok(!text.includes(secret), "the value is redacted");
      assert.ok(!text.includes(secret.slice(-8)), "its tail is not written either");
      assert.match(text, /^\[auth\] value \S*\[redacted\]\S* done\n$/);
    }
  }
});

test("lines are written as they complete; the held rest goes at the end, redacted", () => {
  const out = written();
  const writer = createRedactingLineWriter(out.write, [token]);
  writer.push("first line\nsecond ");
  assert.equal(out.text(), "first line\n");
  writer.push(`with Bearer ${sessionKey.slice(0, 10)}`);
  assert.equal(out.text(), "first line\n");
  writer.push(sessionKey.slice(10));
  writer.end();
  const text = out.text();
  assert.ok(!text.includes(sessionKey.slice(10)), "the key's second half is not written");
  assert.equal(text, "first line\nsecond with Bearer [redacted]");
  writer.end();
  assert.equal(out.text(), text, "a second end writes nothing");
});

test("a bare file capability and a sign-in code outside a query are redacted", () => {
  const text = redactRelayLog(`{"capability":"${capability}","code":"${signInCode}","url":"/f?k=${capability}"}`, [token]);
  assert.ok(!text.includes(capability));
  assert.ok(!text.includes(signInCode));
  assert.equal(text, '{"capability":"[redacted]","code":"[redacted]","url":"/f?k=[redacted]"}');
});
