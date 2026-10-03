#!/usr/bin/env node
// A live check of Claude Cloud on a running relay, for after a restart or a
// deploy: creates a cloud chat on a repository, has the agent make one
// commit (and reset it), reads the reply and checks that the commit trailer
// is the one the relay's attribution setting says, that the repository list
// answers, and that deleting the chat archives the session. Costs one short
// cloud turn on the account the relay is logged in to.
//
//   node scripts/claude-cloud-live-check.mjs --relay http://127.0.0.1:3333 --repo owner/repo
//
// The relay's token comes from OAR_RELAY_TOKEN (or --token); nothing is
// written anywhere. Exit code 0 = every check passed. Use a scratch
// repository the Claude GitHub app can reach: the agent commits in the
// sandbox's clone and resets the commit, nothing is pushed.

import process from 'node:process';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

const relay = arg('relay', 'http://127.0.0.1:3333').replace(/\/+$/, '');
const token = arg('token', process.env.OAR_RELAY_TOKEN || '');
const repo = arg('repo');
const model = arg('model', '');
const timeoutMs = Number(arg('timeout', '300')) * 1000;
if (!token || !repo) {
  console.error('usage: claude-cloud-live-check.mjs --relay <url> --repo <owner/repo> [--model <id>] [--timeout <s>]  (token: OAR_RELAY_TOKEN or --token)');
  process.exit(2);
}

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function call(method, path, body) {
  const response = await fetch(`${relay}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

let conversationId = '';
try {
  const settings = await call('GET', '/api/settings/claude-cloud');
  check('Claude Cloud is on', settings.json?.enabled === true, `status ${settings.status}`);
  check('the relay holds a Claude login', settings.json?.token?.hasToken === true,
    settings.json?.token?.expiresAt ? `expires ${settings.json.token.expiresAt}` : '');

  const repos = await call('GET', '/api/claude-cloud/repos');
  check('the repository list answers', repos.status === 200 && repos.json?.ok === true,
    `${repos.json?.repos?.length ?? 0} repositories, source ${repos.json?.source || '?'}`);

  const claude = await call('GET', '/api/settings/claude');
  const mode = String(claude.json?.attributionMode || 'oar');
  const chosenModel = model || String(settings.json?.defaultModel || '').trim();
  const expectedTrailer = mode === 'oar'
    ? `Co-authored-by: Open Agent Relay (${chosenModel.replace(/\[[^\]]*\]$/, '').split('-').filter(Boolean).map((part, index) => (index === 0 ? 'Claude' : index === 1 ? part[0].toUpperCase() + part.slice(1) : null)).filter(Boolean).join(' ')}`
    : null;

  const repoUrl = /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo}`;
  const created = await call('POST', '/api/conversation/bootstrap', {
    providerType: 'claude-cloud', model: chosenModel, relayMode: 'agent',
    title: 'Claude Cloud live check', cloudSource: { repoUrl },
  });
  conversationId = String(created.json?.conversationId || '');
  if (!check('a cloud chat can be created', created.status === 200 && conversationId, created.text.slice(0, 200))) throw new Error('no chat');

  const stamp = Date.now().toString(36);
  const prompt = `Live check ${stamp}. Do exactly this, nothing else: (1) create the file live-check-${stamp}.txt containing the word check; `
    + '(2) make ONE git commit of it with the subject "Live check" the way you normally write commits; '
    + '(3) run `git log -1 --format=%B` and quote its full output in your reply inside a code block; '
    + '(4) run `git reset --hard HEAD~1` so nothing is left behind. Do not push. Do not create a branch.';
  const sent = await call('POST', '/api/message', { conversationId, text: prompt });
  check('a message is accepted', sent.status === 200, sent.text.slice(0, 120));

  const started = Date.now();
  let reply = null;
  while (Date.now() - started < timeoutMs) {
    const conversation = await call('GET', `/api/conversation/${conversationId}`);
    const messages = conversation.json?.messages || [];
    const assistant = messages.find((message) => message.role === 'assistant');
    if (assistant && !conversation.json?.activeTurn) { reply = assistant; break; }
    await sleep(3000);
  }
  const replyText = String(reply?.text || '');
  check('the reply arrived', !!reply, reply ? `${Math.round((Date.now() - started) / 1000)} s` : `no reply within ${timeoutMs / 1000} s`);
  check('the agent made and reset a commit', /Live check/.test(replyText) && !/error|failed/i.test(replyText.slice(0, 80)), replyText.slice(0, 100).replace(/\s+/g, ' '));
  if (expectedTrailer) {
    check('the commit carries the relay\'s attribution trailer', replyText.includes(expectedTrailer) && !/Claude-Session:/.test(replyText), expectedTrailer);
  } else {
    check(`attribution mode is ${mode}`, mode === 'off' ? !/Co-authored-by/i.test(replyText) : /Co-Authored-By: Claude/.test(replyText));
  }
  const bound = await call('GET', `/api/conversation/${conversationId}`);
  check('the chat is bound to a cloud session', !!bound.json?.cloud?.sessionUrl, bound.json?.cloud?.sessionUrl || '');
} catch (error) {
  check('the check ran to the end', false, error?.message || String(error));
} finally {
  if (conversationId) {
    const deleted = await call('DELETE', `/api/conversation/${conversationId}`);
    check('deleting the chat archives the cloud session', deleted.status === 200 && deleted.json?.ok === true, deleted.text.slice(0, 120));
  }
}
const failed = results.filter((result) => !result.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
