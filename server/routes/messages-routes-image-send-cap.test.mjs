// POST /api/message to an OpenAI image session: the daily cap refuses the
// send from any sender while today's image spend has reached it (unless
// today is allowed), and a turn's `image.preset` is layered between the
// session's defaults and the turn's own fields. REAL schema, image
// repository and operation service.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { makeRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createImageConversationRepository } from '../repositories/image-conversation-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createImageOperationService } from '../services/image-operation-service.mjs';
import { createTokenUsageService } from '../services/token-usage-service.mjs';
import { OPENAI_IMAGE_COST_SOURCES } from '../../shared/openai-image-spend.mjs';

const CONV = 'conv-a';
const NOW = '2026-01-01T00:00:00.000Z';
const ORIGIN = {
  relayId: 'relay-id-b',
  relayName: 'relay-b',
  relayUrl: 'https://relay-b.example.test',
  conversationId: 'conv-source-1',
  conversationTitle: 'poster run',
  provider: 'claude',
  model: 'claude-sonnet-5',
  hops: 1,
};

function seedConversation(db, id, { provider = 'openai', model = 'gpt-image-2', status = 'active', archived = 0 } = {}) {
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'Poster', id, status, archived, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, ?, ?, 'active', ?, ?)
  `).run(`rs-${id}`, id, id, `key-${id}`, model, provider, model, NOW, NOW);
}

function boot(t, { continuity = true, provider = 'openai', model = 'gpt-image-2', cwd = null, references = [], settings = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oar-image-inputs-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs = {
    project: path.join(base, 'project'),
    state: path.join(base, 'state'),
    data: path.join(base, 'data'),
    uploads: path.join(base, 'data', 'uploads'),
    outside: path.join(base, 'outside'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  // A function picks the folder from the tree (its drive's root, say).
  const sessionFolder = typeof cwd === 'function' ? cwd(dirs) : cwd;
  const db = new Database(':memory:');
  applySchema(db);
  seedConversation(db, CONV, { provider, model });
  for (const [key, value] of Object.entries(settings)) {
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, NOW);
  }
  const tokenUsageService = createTokenUsageService({ db, logger: { warn() {}, log() {} } });
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createImageConversationRepository(db) };
  const remoteRelayRepository = createRemoteRelayRepository(db);
  const workspaceCalls = [];
  const deps = makeRouteDeps({
    db,
    stmts,
    io: { emit() {}, volatile: { emit() {} } },
    uuidv4: () => crypto.randomUUID(),
    ts: () => NOW,
    MAX_UPLOAD_ATTACHMENTS: 6,
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    featureFlags: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: continuity },
    tokenUsageService,
    imageOperationService: createImageOperationService({ db, repository: stmts, uuidv4: () => crypto.randomUUID() }),
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, model: 'gpt-image-2', models: ['gpt-image-2', 'dall-e-3', 'gpt-5'] }),
    resolveRequestedModel: (value) => ({ ok: true, model: String(value || 'gpt-5.4-mini'), available: ['gpt-5.4-mini'] }),
    resolveRequestedReasoningEffort: (_model, effort) => ({ ok: true, effort: effort || null, supported: ['none'] }),
    normalizeAttachments: (raw) => (Array.isArray(raw) ? raw.map((entry) => ({ ...entry })) : []),
    collectReferenceAttachmentsFromText: () => ({ attachments: references, skipped: [] }),
    attachmentSummary: () => '',
    parseAttachments: (raw) => JSON.parse(raw || '[]'),
    hydrateAttachment: (value) => value,
    linkUploadReferences: (conversationId, messageId, attachments) => {
      for (const attachment of attachments) {
        if (attachment?.sha256) stmts.insertUploadRef.run(attachment.sha256, conversationId, messageId, NOW);
      }
    },
    // As server-runtime's: the row's stored type, kept by INSERT OR IGNORE.
    persistUploadBuffer: (buffer, { name, type }) => {
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      fs.writeFileSync(path.join(dirs.uploads, sha256), buffer);
      stmts.insertUploadFile.run(sha256, name, type, buffer.length, NOW);
      const row = stmts.getUploadFile.get(sha256);
      return { name: row.original_name, type: row.mime_type, size: row.size_bytes, sha256, path: path.join(dirs.uploads, sha256) };
    },
    uploadsDir: dirs.uploads,
    uploadReadDirs: [dirs.uploads],
    imageInputDenyPaths: { dirs: [dirs.data], files: [path.join(dirs.project, 'config.json')] },
    resolveSessionStateRoot: () => dirs.state,
    resolveConversationWorkspaceState: () => ({ currentWorkspaceRootPath: sessionFolder || dirs.project }),
    maybeApplyWorkspaceRootFromMessage: (text) => {
      workspaceCalls.push(text);
      return { attempted: true, changed: true, resolvedPath: '/' };
    },
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true, state: null }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    getOrCreateConversation: (id, title) => stmts.insertConv.run(id, title, NOW, NOW),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0 }),
    emitToClientsExceptSessionId: () => {},
    remoteRelayInbound: {
      repository: remoteRelayRepository,
      listRelays: () => [],
      selfNames: () => [],
      inboundEnabled: () => true,
      recordUnlock: () => {},
      describeRelay: () => null,
    },
  });
  const routes = captureRoutes(deps);
  const send = (extra = {}) => invokeRoute(routes, 'POST', '/api/message', {
    body: { clientId: 'client-1', conversationId: CONV, text: 'make the sky purple', relayMode: 'agent', ...extra },
  });
  // As an agent's send arrives through relay_tool.
  const agentSend = (extra = {}) => send({ messageId: crypto.randomUUID(), origin: ORIGIN, ...extra });
  const write = (relative, bytes = pngBytes(8, 8), root = dirs.project) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  const operation = (messageId) => db.prepare('SELECT * FROM image_operations WHERE source_message_id = ?').get(messageId);
  const assets = (messageId) => stmts.listAssets.all(operation(messageId).id);
  const counts = () => ({
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    queue: db.prepare('SELECT COUNT(*) AS n FROM queue').get().n,
    uploads: db.prepare('SELECT COUNT(*) AS n FROM uploaded_files').get().n,
    files: fs.readdirSync(dirs.uploads).length,
  });
  return { db, stmts, dirs, deps, send, agentSend, write, operation, assets, counts, workspaceCalls, tokenUsageService };
}

/** Books an image try of `usd` for today, as the image routes do. */
function bookToday(relay, usd, runId = 'image:claim_seed:try1') {
  relay.tokenUsageService.recordTurn({
    conversationId: 'conv-other',
    provider: 'openai',
    billing: 'image',
    report: {
      turnId: `q-${runId}`,
      runId,
      nativeSessionId: null,
      responseMessageId: null,
      at: new Date().toISOString(),
      models: [{ model: 'gpt-image-2', costUsd: usd, costSource: OPENAI_IMAGE_COST_SOURCES.estimate }],
    },
  });
}

const CAP_TEXT = 'Today\'s estimated OpenAI image spend on this relay, USD 0.50, has reached the daily cap of USD 0.50 (Settings → Providers → OpenAI). Nothing was sent. Allow more for today there, or wait until tomorrow (relay time).';

test('at the cap a send to an image model is refused for the owner and for an agent, nothing stored', async (t) => {
  const relay = boot(t, { settings: { openai_image_daily_cap_usd: '0.5' } });
  assert.equal((await relay.send({ text: 'a first kite' })).status, 200);
  const before = relay.counts();
  bookToday(relay, 0.5);
  for (const sent of [await relay.send({ text: 'a kite' }), await relay.agentSend({ text: 'a kite' })]) {
    assert.equal(sent.status, 409, JSON.stringify(sent.body));
    assert.equal(sent.body.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
    assert.equal(sent.body.error, CAP_TEXT);
  }
  // A new image session is refused the same way.
  const fresh = await relay.send({ conversationId: undefined, newConversation: true, providerType: 'openai', model: 'gpt-image-2', text: 'a kite' });
  assert.equal(fresh.status, 409, JSON.stringify(fresh.body));
  assert.equal(fresh.body.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
  assert.deepEqual(relay.counts(), before);
});

test('the owner\'s override for today lifts the refusal; no cap never refuses', async (t) => {
  const relay = boot(t, { settings: { openai_image_daily_cap_usd: '0.5' } });
  bookToday(relay, 0.75);
  assert.equal((await relay.agentSend({ text: 'a kite' })).status, 409);
  relay.db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('openai_image_cap_override_day', JSON.stringify(relay.tokenUsageService.localDay()), NOW);
  assert.equal((await relay.agentSend({ text: 'a kite' })).status, 200);
  assert.equal((await relay.send({ text: 'a kite' })).status, 200);
  const open = boot(t, { settings: { openai_image_daily_cap_usd: '0' } });
  bookToday(open, 50);
  assert.equal((await open.send({ text: 'a kite' })).status, 200);
});

test('below the cap, and on a chat model at the cap, the send goes on', async (t) => {
  const relay = boot(t, { settings: { openai_image_daily_cap_usd: '0.5' } });
  bookToday(relay, 0.49);
  assert.equal((await relay.agentSend({ text: 'a kite' })).status, 200);
  const chat = boot(t, { model: 'gpt-5', settings: { openai_image_daily_cap_usd: '0.5' } });
  bookToday(chat, 5);
  const sent = await chat.send({ text: 'hello' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
});

const parameters = (relay, sent) => JSON.parse(relay.operation(sent.body.messageId).parameters_json);

test('an agent\'s preset lies over the session defaults and under its own fields', async (t) => {
  const relay = boot(t);
  relay.stmts.writeConversationImageDefaults(CONV, { size: '1536x1024', quality: 'low', output_format: 'webp' });
  const sent = await relay.agentSend({ image: { preset: 'Wallpaper 4K', quality: 'medium' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(parameters(relay, sent), { count: 1, output_format: 'webp', quality: 'medium', size: '3840x2160' });
  // An agent's effort counts below the defaults, and so below the preset.
  const effort = await relay.agentSend({ reasoningEffort: 'low', image: { preset: 'wallpaper 4k' } });
  assert.equal(parameters(relay, effort).quality, 'high');
});

test('the owner\'s preset lies over the session defaults and under the composer\'s own quality and size', async (t) => {
  const relay = boot(t);
  relay.stmts.writeConversationImageDefaults(CONV, { size: '1536x1024', quality: 'low' });
  const named = await relay.send({ text: 'a lighthouse', image: { preset: 'Wallpaper 4K' } });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.deepEqual(parameters(relay, named), { count: 1, quality: 'high', size: '3840x2160' });
  const composer = await relay.send({ text: 'a lighthouse at dusk', reasoningEffort: 'medium', contextTier: '1024x1024', image: { preset: 'Wallpaper 4K' } });
  assert.equal(composer.status, 200, JSON.stringify(composer.body));
  assert.deepEqual(parameters(relay, composer), { count: 1, quality: 'medium', size: '1024x1024' });
});

test('an own preset is found by its name in any case; an unknown one is refused, nothing stored', async (t) => {
  const relay = boot(t, { settings: { openai_image_presets: JSON.stringify([{ name: 'Poster draft', size: '1024x1536', quality: 'low', count: 2 }]) } });
  const sent = await relay.agentSend({ image: { preset: 'poster DRAFT' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(parameters(relay, sent), { count: 2, quality: 'low', size: '1024x1536' });
  const before = relay.counts();
  for (const send of [relay.agentSend, relay.send]) {
    const refused = await send({ image: { preset: 'Nope' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'IMAGE_INPUT_REFUSED');
    assert.match(refused.body.error, /^no image preset "Nope" here; presets: Draft square, .*Poster draft\. Nothing was sent\.$/);
  }
  assert.deepEqual(relay.counts(), before);
});

test('a transparent preset over a jpeg default is caught on the merged options', async (t) => {
  const relay = boot(t, { settings: { openai_image_presets: JSON.stringify([{ name: 'Clear', background: 'transparent' }]) } });
  relay.stmts.writeConversationImageDefaults(CONV, { output_format: 'jpeg' });
  const before = relay.counts();
  const refused = await relay.agentSend({ image: { preset: 'Clear' } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /background "transparent" needs output_format png or webp/);
  assert.deepEqual(relay.counts(), before);
  // With the format named on the turn it goes.
  const sent = await relay.agentSend({ image: { preset: 'Clear', output_format: 'png' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(parameters(relay, sent), { background: 'transparent', count: 1, output_format: 'png' });
});
