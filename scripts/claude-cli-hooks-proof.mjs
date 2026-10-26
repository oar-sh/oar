#!/usr/bin/env node
// A proof on the bundled Claude Code CLI that no hook and no statusLine
// command runs in a chat on a key of the relay's (DeepSeek, Claude API), not
// even a SessionStart hook before the CLI has taken the backend's live pins,
// while a subscription chat in the same folder runs them. Nothing leaves the
// loopback interface and no real key is involved: a fake Anthropic API runs
// on a random port of 127.0.0.1, every key is a short placeholder, and every
// other connection is sent to a proxy trap that refuses it.
//
// The host it builds in a temp folder (HOME and CLAUDE_CONFIG_DIR, and the
// DeepSeek backend's own config directory): the user's settings.json and the
// chat folder's .claude/settings.json and .claude/settings.local.json each
// have a SessionStart, a UserPromptSubmit, a PreToolUse and a Stop hook and a
// statusLine command, each of which only appends to a marker file of its own
// (never a value), and each sets disableAllHooks: false, a settings file
// trying to turn the hooks back on over the command line's true. A plugin,
// installed with the CLI's own `plugin marketplace add` and `plugin install`
// from a local marketplace folder (in the user's and in DeepSeek's config
// directory), has the same four hooks. The fake API answers the first
// request of the main loop with a Bash tool call, so that PreToolUse has a
// tool to fire on (the tool itself is denied), and every later one with
// PONG. Each run spawns a fresh CLI as the worker does
// (startClaudeSession):
//
//   control:    no backend, the subscription chat's settings; the placeholder
//               key and the fake endpoint come from the worker's environment
//               (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL). Its markers show the
//               hooks run in an SDK session at all;
//   DeepSeek:   the DeepSeek backend, on the fake API (DEEPSEEK_BASE_URL);
//   Claude API: the Claude API backend, on the fake API
//               (OAR_ANTHROPIC_API_BASE_URL).
//
//   nice -n 19 node scripts/claude-cli-hooks-proof.mjs
//
// Exit code 0 = the control wrote its SessionStart, UserPromptSubmit and
// PreToolUse markers (the plugin's too) and neither key chat wrote any
// marker, with the tool call made in each; 1 = otherwise. The control's
// statusLine and Stop markers are reported, not required: the CLI may not
// run those without a terminal.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createClaudeApiClaudeBackend } from '../server/claude-api-worker/claude-api-backend.mjs';
import { startClaudeSession } from '../server/claude-worker/claude-sdk-adapter.mjs';
import { createDeepSeekClaudeBackend } from '../server/deepseek-worker/deepseek-claude-backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
const TURN_TIMEOUT_MS = 240_000;
// Hooks that run after the result are given this long to write.
const SETTLE_MS = 2_000;

// Placeholders, short enough to be no key's shape.
const CONTROL_KEY = 'sk-ant-api03-test-7001';
const DEEPSEEK_KEY = 'sk-test-7002';
const CLAUDE_API_KEY = 'sk-ant-api03-test-7003';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// The fake API. The first request of the main loop (it offers the Bash tool)
// is answered with a Bash call; every other one with PONG.
let requests = [];
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
// Anywhere in the conversation: with hooks on, Claude Code can add a message
// of hook output after the tool result.
function hasToolResult(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  return messages.some((message) => Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_result'));
}
let messageCount = 0;
function answerMessages(res, parsed) {
  messageCount += 1;
  const id = `msg_fake_${messageCount}`;
  const model = parsed?.model || 'claude-sonnet-5-5';
  const usage = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const offersBash = Array.isArray(parsed?.tools) && parsed.tools.some((tool) => tool?.name === 'Bash');
  // One Bash call per run, so a request the fake misreads can't loop the turn.
  const toolCall = offersBash && !hasToolResult(parsed) && !requests.some((entry) => entry.toolCall);
  const block = toolCall
    ? { type: 'tool_use', id: `toolu_fake_${messageCount}`, name: 'Bash', input: { command: 'true', description: 'The hooks proof\'s tool call' } }
    : { type: 'text', text: 'PONG' };
  const stopReason = toolCall ? 'tool_use' : 'end_turn';
  requests.push({ path: parsed?.__path, toolCall, toolResult: hasToolResult(parsed), stream: parsed?.stream === true });
  if (parsed?.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_fake_${messageCount}` });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stopReason, stop_sequence: null, usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_fake_${messageCount}` });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (toolCall) {
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PONG' } });
  }
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } });
  send('message_stop', {});
  res.end();
}
async function handler(req, res) {
  const body = await readBody(req);
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  // DeepSeek's endpoint is the fake's /anthropic.
  const route = String(req.url || '').replace(/\?.*$/, '').replace(/^\/anthropic(?=\/)/, '');
  if (req.method === 'POST' && route === '/v1/messages') return answerMessages(res, { ...parsed, __path: route });
  if (req.method === 'POST' && route === '/v1/messages/count_tokens') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: 12 }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not on the fake API' } }));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
const fake = http.createServer((req, res) => { handler(req, res); });
const fakeUrl = `http://127.0.0.1:${await listen(fake)}`;
const trapped = [];
const trap = http.createServer((req, res) => {
  trapped.push(`${req.method} ${String(req.url || '').replace(/\?.*$/, '')}`);
  res.writeHead(502);
  res.end();
});
trap.on('connect', (req, socket) => {
  trapped.push(`CONNECT ${req.url}`);
  socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
});
const trapUrl = `http://127.0.0.1:${await listen(trap)}`;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-claude-cli-hooks-proof-'));
const home = path.join(temp, 'home');
const configDir = path.join(home, '.claude');
const deepseekConfigDir = path.join(temp, 'deepseek-claude');
const work = path.join(temp, 'work');
const markers = path.join(temp, 'markers');
for (const dir of [configDir, deepseekConfigDir, path.join(work, '.claude'), markers]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];
/**
 * Hooks and a statusLine command of `scope`, each appending to its marker,
 * and disableAllHooks: false.
 */
function hookSettings(scope) {
  const mark = (what) => `echo ran >> '${path.join(markers, `${scope}-${what}`)}'`;
  const hooks = {};
  for (const event of EVENTS) {
    hooks[event] = [{ ...(event === 'PreToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: mark(event) }] }];
  }
  return { disableAllHooks: false, hooks, statusLine: { type: 'command', command: `${mark('statusLine')}; echo status` } };
}
const userSettings = JSON.stringify(hookSettings('user'), null, 2);
fs.writeFileSync(path.join(configDir, 'settings.json'), userSettings);
fs.writeFileSync(path.join(deepseekConfigDir, 'settings.json'), userSettings);
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), JSON.stringify(hookSettings('folder'), null, 2));
fs.writeFileSync(path.join(work, '.claude', 'settings.local.json'), JSON.stringify(hookSettings('local'), null, 2));

// A plugin with the same hooks, in a local marketplace (no network). It has
// no statusLine: a plugin cannot set one.
const marketplace = path.join(temp, 'marketplace');
const pluginDir = path.join(marketplace, 'plugins', 'proof-hooks');
for (const dir of [path.join(marketplace, '.claude-plugin'), path.join(pluginDir, '.claude-plugin'), path.join(pluginDir, 'hooks')]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
fs.writeFileSync(path.join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
  name: 'oar-hooks-proof',
  owner: { name: 'OAR hooks proof' },
  plugins: [{ name: 'proof-hooks', source: './plugins/proof-hooks', description: 'The hooks proof\'s plugin' }],
}, null, 2));
fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'proof-hooks', version: '1.0.0', description: 'The hooks proof\'s plugin' }, null, 2));
fs.writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: hookSettings('plugin').hooks }, null, 2));
const SCOPES = ['user', 'folder', 'local', 'plugin'];

// The worker's environment: this process's, without any credential of the
// host's, on the temp host.
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_API_KEY|CLAUDE_CODE_SESSION_ACCESS_TOKEN|CLAUDE_CONFIG_DIR|OAR_|DEEPSEEK_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  HOME: home,
  CLAUDE_CONFIG_DIR: configDir,
  XDG_CONFIG_HOME: path.join(temp, 'xdg-config'),
  XDG_CACHE_HOME: path.join(temp, 'xdg-cache'),
  XDG_DATA_HOME: path.join(temp, 'xdg-data'),
  XDG_STATE_HOME: path.join(temp, 'xdg-state'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  HTTPS_PROXY: trapUrl,
  HTTP_PROXY: trapUrl,
  https_proxy: trapUrl,
  http_proxy: trapUrl,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  DEEPSEEK_API_KEY: DEEPSEEK_KEY,
  DEEPSEEK_BASE_URL: fakeUrl,
  DEEPSEEK_CLAUDE_CONFIG_DIR: deepseekConfigDir,
  OAR_CLAUDE_API_KEY: CLAUDE_API_KEY,
  OAR_ANTHROPIC_API_BASE_URL: fakeUrl,
});

/**
 * Installs the plugin in `configDirectory` with the CLI's own commands, as a
 * user would; they add it to that directory's settings.json (enabledPlugins).
 */
async function installPlugin(configDirectory) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDirectory };
  for (const args of [['plugin', 'marketplace', 'add', marketplace], ['plugin', 'install', 'proof-hooks@oar-hooks-proof']]) {
    // Not synchronous: the fake API and the proxy trap answer from this process.
    await promisify(execFile)(CLI, args, { env, cwd: temp, timeout: 60_000 });
  }
  const settings = JSON.parse(fs.readFileSync(path.join(configDirectory, 'settings.json'), 'utf8'));
  return settings.enabledPlugins?.['proof-hooks@oar-hooks-proof'] === true && settings.disableAllHooks === false;
}

function markersWritten() {
  return fs.readdirSync(markers).sort();
}

/** One run: a fresh CLI, the stream read until its result. */
async function runTurn(label, { backend, model, env = null }) {
  requests = [];
  trapped.length = 0;
  fs.rmSync(markers, { recursive: true, force: true });
  fs.mkdirSync(markers, { mode: 0o700 });
  const saved = {};
  for (const [name, value] of Object.entries(env || {})) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TURN_TIMEOUT_MS);
  let turn = null;
  try {
    turn = startClaudeSession({
      content: 'Run the command true, then reply with the single word PONG.',
      cwd: work,
      model,
      relayMode: 'agent',
      abortController,
      canUseTool: async () => ({ behavior: 'deny', message: 'no tools in this proof' }),
      pathToClaudeCodeExecutable: CLI,
      ...(backend ? { backend } : {}),
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const pinned = turn.liveFlagSettingsApplied || Promise.resolve(null);
  let init = null;
  let result = null;
  let failure = '';
  try {
    for await (const message of turn) {
      if (message.type === 'system' && message.subtype === 'init' && !init) init = message;
      if (message.type === 'result') {
        result = message;
        turn.endInput();
      }
    }
  } catch (error) {
    failure = String(error?.message || error).slice(0, 200);
  } finally {
    clearTimeout(timer);
    turn.endInput?.();
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const pinResult = await pinned;
  const written = markersWritten();
  const toolCalls = requests.filter((entry) => entry.toolCall).length;
  const toolResults = requests.filter((entry) => entry.toolResult).length;
  console.log(`\n== ${label}`);
  console.log(`live pins: ${pinResult === null ? 'none (no backend)' : (pinResult ? 'taken' : 'REFUSED')}; init apiKeySource ${JSON.stringify(init?.apiKeySource ?? null)}`);
  console.log(`fake API: ${requests.length} message request(s), ${toolCalls} answered with the Bash call, ${toolResults} carrying its result; proxy trap: ${trapped.length ? trapped.join(', ') : 'nothing'}`);
  console.log(`result: ${result ? `${result.subtype}${result.is_error ? ' (error)' : ''}: ${String(result.result || '').slice(0, 80)}` : `none${failure ? ` (${failure})` : ''}`}`);
  console.log(`markers: ${written.length ? written.join(', ') : 'none'}`);
  return { result, pinResult, written, toolCalls, toolResults, trapped: [...trapped] };
}

let exitCode = 0;
try {
  check('the bundled CLI is there', fs.existsSync(CLI), path.relative(ROOT, CLI));
  check('the plugin is installed and enabled in the user\'s settings', await installPlugin(configDir));
  check('the plugin is installed and enabled in DeepSeek\'s settings', await installPlugin(deepseekConfigDir));

  const control = await runTurn('control: a subscription chat (no backend), the placeholder key in the worker\'s environment', {
    backend: null,
    model: 'claude-sonnet-5-5',
    env: { ANTHROPIC_API_KEY: CONTROL_KEY, ANTHROPIC_BASE_URL: fakeUrl },
  });
  check('control: the turn ends with PONG', control.result?.subtype === 'success' && /PONG/.test(String(control.result?.result || '')));
  check('control: the tool call was made', control.toolCalls > 0 && control.toolResults > 0);
  for (const scope of SCOPES) {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse']) {
      check(`control: the ${scope} settings' ${event} hook ran`, control.written.includes(`${scope}-${event}`));
    }
  }
  for (const what of ['Stop', 'statusLine']) {
    const ran = SCOPES.filter((scope) => control.written.includes(`${scope}-${what}`));
    console.log(`note  control: ${what} ${ran.length ? `ran (${ran.join(', ')})` : 'did not run (not required)'}`);
  }

  for (const [label, backend, model] of [
    ['DeepSeek', createDeepSeekClaudeBackend({ env: process.env }), 'deepseek-flash'],
    ['Claude API', createClaudeApiClaudeBackend({ env: process.env }), 'claude-sonnet-5-5'],
  ]) {
    const run = await runTurn(`${label}: the backend as the worker runs it, in the same folder`, { backend, model });
    check(`${label}: the live pins were taken`, run.pinResult === true);
    check(`${label}: the turn ends with PONG`, run.result?.subtype === 'success' && /PONG/.test(String(run.result?.result || '')));
    check(`${label}: the tool call was made`, run.toolCalls > 0 && run.toolResults > 0);
    check(`${label}: no hook and no statusLine command ran`, run.written.length === 0, run.written.length ? run.written.join(', ') : 'no marker');
    check(`${label}: nothing went past the loopback`, run.trapped.length === 0, run.trapped.join(', '));
  }
} finally {
  await Promise.all([fake, trap].map((server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })));
  fs.rmSync(temp, { recursive: true, force: true });
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
exitCode = failed.length ? 1 : 0;
process.exit(exitCode);
