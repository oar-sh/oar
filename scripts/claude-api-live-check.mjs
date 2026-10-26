#!/usr/bin/env node
// A live check of the Claude API provider on a running relay: creates a
// Claude API chat in a scratch folder and runs short turns on Sonnet. The
// turns cover a tool turn that writes and reads a file and a follow-up that
// needs the tool turn's history (the CLI resumed on the key). Then the
// refusals: the settings route refuses a Claude OAuth token without storing
// it, and with --bad-key a turn on a key Anthropic refuses ends with the
// Claude API key note. With --cap the monthly cap is lowered below this
// month's estimate for one send, which must be refused, and put back. Then it
// deletes the chat. Costs a few cents on the Claude API key saved in the
// relay.
//
//   node scripts/claude-api-live-check.mjs --relay http://127.0.0.1:3333 --cwd /path/to/scratch-folder [--cap] [--bad-key]
//
// The relay's token comes from OAR_RELAY_TOKEN (or --token); the Claude API
// key stays in the relay and is never read here. The folder must exist and
// may be written to: the agent creates one file there, which this script
// removes.
//
// --bad-key replaces the saved key with a placeholder Anthropic refuses and
// does not put it back (this script never holds the real key): enter the key
// again in Settings → Providers → Claude API afterwards. Run it last, on a
// test relay.
//
// Exit code 0 = every check passed (a skipped one counts as passed).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const relay = arg('relay', 'http://127.0.0.1:3333').replace(/\/+$/, '');
const token = arg('token', process.env.OAR_RELAY_TOKEN || '');
const cwd = arg('cwd');
const model = arg('model', 'claude-sonnet-5-5');
const timeoutMs = Number(arg('timeout', '240')) * 1000;
const withCap = flag('cap');
const withBadKey = flag('bad-key');
if (!token || !cwd) {
  console.error('usage: claude-api-live-check.mjs --relay <url> --cwd <scratch folder> [--model <id>] [--cap] [--bad-key] [--timeout <s>]  (token: OAR_RELAY_TOKEN or --token)');
  process.exit(2);
}

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function call(method, route, body) {
  const response = await fetch(`${relay}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
function skip(name, reason) {
  console.log(`SKIP  ${name} — ${reason}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').slice(0, max);
// Anything shaped like an Anthropic key or token, never printed or answered.
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/;

let conversationId = '';

/** Sends one message and waits until the chat has one more assistant reply and no turn runs. */
async function turn(text, extra = {}) {
  const before = (await call('GET', `/api/conversation/${conversationId}`)).json?.messages
    ?.filter((message) => message.role === 'assistant').length || 0;
  const sent = await call('POST', '/api/message', { conversationId, text, relayMode: 'agent', ...extra });
  if (sent.status !== 200) return { sent, reply: null };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const conversation = await call('GET', `/api/conversation/${conversationId}`);
    const replies = (conversation.json?.messages || []).filter((message) => message.role === 'assistant');
    if (replies.length > before && !conversation.json?.activeTurn) {
      return { sent, reply: replies[replies.length - 1], seconds: Math.round((Date.now() - started) / 1000) };
    }
    await sleep(3000);
  }
  return { sent, reply: null };
}

function refused(replyText) {
  return /API Error|Error code: relay\.|turn failed|System note/i.test(replyText);
}

const stamp = Date.now().toString(36);
const fileName = `claude-api-live-check-${stamp}.txt`;
// The cap as it was, put back after the cap step; undefined: not touched.
let savedCap;
try {
  check('the scratch folder exists', fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true, cwd);
  const settings = await call('GET', '/api/settings/claude-api');
  check('Claude API is configured and on', settings.json?.configured === true && settings.json?.enabled === true, `status ${settings.status}`);
  check('the settings answer carries no key', !KEY_SHAPE.test(settings.text));

  const created = await call('POST', '/api/conversation/bootstrap', {
    providerType: 'claude-api', model, relayMode: 'agent', title: 'Claude API live check', cwd,
  });
  conversationId = String(created.json?.conversationId || '');
  if (!check('a Claude API chat can be created', created.status === 200 && !!conversationId, oneLine(created.text, 200))) throw new Error('no chat');

  const tools = await turn(
    `Live check ${stamp}. Use your tools: (1) create the file ${fileName} in the current folder containing exactly the word check; `
    + '(2) list the folder and read the file back with a tool; (3) reply with the file content and the word DONE. Do nothing else.',
    { reasoningEffort: 'low' },
  );
  const toolsText = String(tools.reply?.text || '');
  check('a tool turn answers', !!tools.reply && !refused(toolsText), tools.reply ? `${tools.seconds} s: ${oneLine(toolsText)}` : `no reply (${tools.sent.status})`);
  check('the agent wrote the file', fs.existsSync(path.join(cwd, fileName)));

  const followUp = await turn('What is the exact name of the file you created? Answer with the file name only.', { reasoningEffort: 'low' });
  const followUpText = String(followUp.reply?.text || '');
  check('a follow-up after the tool turn answers from the session', !!followUp.reply && !refused(followUpText) && followUpText.includes(fileName),
    followUp.reply ? `${followUp.seconds} s: ${oneLine(followUpText)}` : 'no reply');

  const context = await call('GET', `/api/context/${conversationId}`);
  check('the context panel has the chat\'s numbers', context.status === 200 && context.json?.providerType === 'claude-api' && !!context.json?.snapshot,
    `status ${context.status}, provider ${context.json?.providerType || '?'}`);

  // A Claude OAuth token is refused by its prefix and nothing changes: the
  // saved key stays and the chat goes on.
  const oauthShaped = `sk-ant-oat01-${crypto.randomBytes(24).toString('hex')}`;
  const oauth = await call('POST', '/api/settings/claude-api', { apiKey: oauthShaped });
  check('the settings route refuses a Claude OAuth token, without quoting it', oauth.status === 400 && /^claude-api-key-/.test(String(oauth.json?.code || '')) && !oauth.text.includes(oauthShaped),
    `status ${oauth.status}, code ${oauth.json?.code || '?'}`);
  const after = await call('GET', '/api/settings/claude-api');
  check('the saved key is still the one in use', after.json?.configured === true && after.json?.enabled === true);

  // The cap: the relay refuses a new Claude API turn once this month's
  // estimate reaches it.
  const usage = await call('GET', '/api/usage?providers=claude-api');
  const card = (usage.json?.providers || []).find((entry) => entry?.provider === 'claude-api') || null;
  if (!withCap) {
    skip('a send over the monthly cap is refused', 'pass --cap to lower the cap below this month\'s estimate for one send');
  } else if (!card) {
    skip('a send over the monthly cap is refused', 'this relay has no Claude API spend card, so no cap to reach');
  } else {
    savedCap = after.json?.monthlyCapUsd ?? null;
    const lowered = await call('POST', '/api/settings/claude-api', { monthlyCapUsd: 0.01 });
    check('the cap can be lowered to $0.01', lowered.status === 200 && Number(lowered.json?.monthlyCapUsd) === 0.01, `status ${lowered.status}`);
    const capped = await turn('Reply with the single word PONG.', { reasoningEffort: 'low' });
    const cappedText = String(capped.reply?.text || capped.sent.text || '');
    const stopped = capped.sent.status !== 200 || (refused(cappedText) && /cap/i.test(cappedText));
    check('a send over the monthly cap is refused with a note', stopped && !/PONG/.test(cappedText),
      `status ${capped.sent.status}: ${oneLine(cappedText)}`);
  }

  if (withBadKey) {
    // A key in the Console format that no account has: Anthropic answers 401.
    const badKey = `sk-ant-api03-${crypto.randomBytes(32).toString('base64url')}`;
    const saved = await call('POST', '/api/settings/claude-api', { apiKey: badKey });
    check('a placeholder key can be saved', saved.status === 200 && !saved.text.includes(badKey), `status ${saved.status}`);
    const bad = await turn('Reply with the single word PONG.', { reasoningEffort: 'low' });
    const badText = String(bad.reply?.text || '');
    check('a turn on a refused key ends with the Claude API key note', !!bad.reply && /Settings → Providers → Claude API/.test(badText) && !badText.includes(badKey),
      bad.reply ? `${bad.seconds} s: ${oneLine(badText)}` : `no reply (${bad.sent.status})`);
    console.log('NOTE  the saved key is now a placeholder: enter the Claude API key again in Settings → Providers → Claude API.');
  } else {
    skip('a turn on a refused key ends with the Claude API key note', 'pass --bad-key (replaces the saved key; enter it again afterwards)');
  }
} catch (error) {
  check('the check ran to the end', false, error?.message || String(error));
} finally {
  try { fs.rmSync(path.join(cwd, fileName), { force: true }); } catch {}
  if (savedCap !== undefined) {
    const restored = await call('POST', '/api/settings/claude-api', { monthlyCapUsd: savedCap });
    check('the cap is back as it was', restored.status === 200 && (restored.json?.monthlyCapUsd ?? null) === savedCap,
      `status ${restored.status}, cap ${restored.json?.monthlyCapUsd ?? 'none'}`);
  }
  if (conversationId) {
    const deleted = await call('DELETE', `/api/conversation/${conversationId}`);
    check('the chat can be deleted', deleted.status === 200 && deleted.json?.ok === true, oneLine(deleted.text));
  }
}
const failed = results.filter((result) => !result.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
