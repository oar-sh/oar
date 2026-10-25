#!/usr/bin/env node
// A live check of the DeepSeek provider on a running relay: creates a
// DeepSeek chat in a scratch folder and runs four short turns on
// deepseek-flash. The turns cover a tool turn that writes and reads a file, a
// follow-up that needs the reasoning of the tool turn sent back (DeepSeek
// answers 400 when it is missing), a turn at the lowest effort, and a model
// switch. Then it deletes the chat. Costs a few cents on the DeepSeek key
// saved in the relay.
//
//   node scripts/deepseek-live-check.mjs --relay http://127.0.0.1:3333 --cwd /path/to/scratch-folder
//
// The relay's token comes from OAR_RELAY_TOKEN (or --token); the DeepSeek key
// stays in the relay and is never read here. The folder must exist and may be
// written to: the agent creates one file there, which this script removes.
// Exit code 0 = every check passed.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

const relay = arg('relay', 'http://127.0.0.1:3333').replace(/\/+$/, '');
const token = arg('token', process.env.OAR_RELAY_TOKEN || '');
const cwd = arg('cwd');
const switchModel = arg('switch-model', 'deepseek-v4-pro');
const timeoutMs = Number(arg('timeout', '240')) * 1000;
if (!token || !cwd) {
  console.error('usage: deepseek-live-check.mjs --relay <url> --cwd <scratch folder> [--switch-model <id>|none] [--timeout <s>]  (token: OAR_RELAY_TOKEN or --token)');
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').slice(0, max);

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
const fileName = `deepseek-live-check-${stamp}.txt`;
try {
  check('the scratch folder exists', fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true, cwd);
  const settings = await call('GET', '/api/settings/deepseek');
  check('DeepSeek is configured and on', settings.json?.configured === true && settings.json?.enabled === true, `status ${settings.status}`);
  check('the settings answer carries no key', !/sk-[A-Za-z0-9]{8,}/.test(settings.text));

  const created = await call('POST', '/api/conversation/bootstrap', {
    providerType: 'deepseek', model: 'deepseek-flash', relayMode: 'agent', title: 'DeepSeek live check', cwd,
  });
  conversationId = String(created.json?.conversationId || '');
  if (!check('a DeepSeek chat can be created', created.status === 200 && !!conversationId, oneLine(created.text, 200))) throw new Error('no chat');

  const tools = await turn(
    `Live check ${stamp}. Use your tools: (1) create the file ${fileName} in the current folder containing exactly the word check; `
    + '(2) list the folder and read the file back with a tool; (3) reply with the file content and the word DONE. Do nothing else.',
  );
  const toolsText = String(tools.reply?.text || '');
  check('a tool turn answers', !!tools.reply && !refused(toolsText), tools.reply ? `${tools.seconds} s: ${oneLine(toolsText)}` : `no reply (${tools.sent.status})`);
  check('the agent wrote the file', fs.existsSync(path.join(cwd, fileName)));

  const followUp = await turn('What is the exact name of the file you created? Answer with the file name only.');
  const followUpText = String(followUp.reply?.text || '');
  check('a follow-up after the tool turn answers (reasoning sent back)', !!followUp.reply && !refused(followUpText) && followUpText.includes(fileName),
    followUp.reply ? `${followUp.seconds} s: ${oneLine(followUpText)}` : 'no reply');

  const quick = await turn('Reply with the single word PONG.', { reasoningEffort: 'low' });
  const quickText = String(quick.reply?.text || '');
  check('a turn at effort low answers (a respawn of the CLI)', !!quick.reply && !refused(quickText) && /PONG/.test(quickText),
    quick.reply ? `${quick.seconds} s: ${oneLine(quickText)}` : 'no reply');

  if (switchModel && switchModel !== 'none') {
    const switched = await turn('In one short sentence: which file did we create earlier?', { model: switchModel, reasoningEffort: 'low' });
    const switchedText = String(switched.reply?.text || '');
    check(`a switch to ${switchModel} keeps the session`, !!switched.reply && !refused(switchedText) && switchedText.includes(stamp),
      switched.reply ? `${switched.seconds} s: ${oneLine(switchedText)}` : 'no reply');
  }

  const context = await call('GET', `/api/context/${conversationId}`);
  check('the context panel has DeepSeek\'s numbers', context.status === 200 && context.json?.providerType === 'deepseek',
    `status ${context.status}, provider ${context.json?.providerType || '?'}`);
} catch (error) {
  check('the check ran to the end', false, error?.message || String(error));
} finally {
  try { fs.rmSync(path.join(cwd, fileName), { force: true }); } catch {}
  if (conversationId) {
    const deleted = await call('DELETE', `/api/conversation/${conversationId}`);
    check('the chat can be deleted', deleted.status === 200 && deleted.json?.ok === true, oneLine(deleted.text));
  }
}
const failed = results.filter((result) => !result.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
