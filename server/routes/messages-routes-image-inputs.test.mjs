import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { buildDequeuedRelayMessage } from './messages-routes.mjs';
import { makeRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createImageConversationRepository } from '../repositories/image-conversation-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createImageOperationService } from '../services/image-operation-service.mjs';
import { GIF_BYTES, jpegBytes, pngBytes } from '../services/image-input-test-fixtures.mjs';

// POST /api/message with imagePaths and image (a relay_tool send or
// create_session with images): the paths are read on this relay, against the
// REAL schema, image repository and operation service, in temp folders. Every
// refusal is a 400 IMAGE_INPUT_REFUSED that queues and stores nothing.

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

function boot(t, { continuity = true, provider = 'openai', model = 'gpt-image-2', cwd = null, references = [] } = {}) {
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
  return { db, stmts, dirs, deps, send, agentSend, write, operation, assets, counts, workspaceCalls };
}

function assertRefused(result, pattern) {
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, 'IMAGE_INPUT_REFUSED');
  assert.match(result.body.error, pattern);
}

const NOTHING = { messages: 0, queue: 0, uploads: 0, files: 0 };

test('an image in the session folder becomes an asset of the operation, and the answer counts it', async (t) => {
  const relay = boot(t);
  const file = relay.write('sketch.png', pngBytes(64, 32));
  const sent = await relay.agentSend({ imagePaths: [file] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.imageInputs, 1);
  assert.equal(sent.body.imageInputsDropped, undefined);
  const [asset] = relay.assets(sent.body.messageId);
  assert.equal(asset.media_type, 'image/png');
  assert.equal(asset.original_name, 'sketch.png');
  assert.equal(relay.operation(sent.body.messageId).kind, 'generate');
  const attachments = JSON.parse(relay.db.prepare('SELECT attachments FROM messages WHERE id = ?').get(sent.body.messageId).attachments);
  assert.deepEqual(attachments.map((entry) => [entry.type, entry.width, entry.height]), [['image/png', 64, 32]]);
});

test('every refused path queues and stores nothing', async (t) => {
  const relay = boot(t);
  relay.write('empty.png', Buffer.alloc(0));
  const big = relay.write('big.png');
  fs.truncateSync(big, 20 * 1024 * 1024 + 1);
  relay.write('animated.png', pngBytes(8, 8, { animated: true }));
  relay.write('moving.png', GIF_BYTES);
  relay.write('config.json', pngBytes(8, 8));
  const outside = relay.write('b.png', pngBytes(8, 8), relay.dirs.outside);
  const cases = [
    [path.join(relay.dirs.project, 'empty.png'), /is empty/],
    [big, /larger than 20 MB/],
    [path.join(relay.dirs.project, 'animated.png'), /animated image/],
    [path.join(relay.dirs.project, 'moving.png'), /not a PNG, JPEG or WebP image/],
    [relay.dirs.project, /not a regular file/],
    [path.join(relay.dirs.project, 'config.json'), /own data/],
    [outside, /outside this session's folder/],
    ['project/b.png', /not an absolute path/],
  ];
  for (const [file, pattern] of cases) {
    // A good image beside it does not let the send through.
    const good = relay.write('good.png', pngBytes(9, 9));
    assertRefused(await relay.agentSend({ imagePaths: [good, file] }), pattern);
  }
  assert.deepEqual(relay.counts(), NOTHING);
});

test('a link out of the session folder and a dangling one are refused; a folder that is a link is followed', { skip: process.platform === 'win32' }, async (t) => {
  const outside = boot(t);
  outside.write('b.png', pngBytes(8, 8), outside.dirs.outside);
  fs.symlinkSync(path.join(outside.dirs.outside, 'b.png'), path.join(outside.dirs.project, 'escape.png'));
  fs.symlinkSync(path.join(outside.dirs.outside, 'gone.png'), path.join(outside.dirs.project, 'dangling.png'));
  assertRefused(await outside.agentSend({ imagePaths: [path.join(outside.dirs.project, 'escape.png')] }), /outside this session's folder/);
  assertRefused(await outside.agentSend({ imagePaths: [path.join(outside.dirs.project, 'dangling.png')] }), /was not found/);
  assert.deepEqual(outside.counts(), NOTHING);

  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oar-image-link-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'real'));
  fs.writeFileSync(path.join(base, 'real', 'a.png'), pngBytes(8, 8));
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'linked'));
  const linked = boot(t, { cwd: path.join(base, 'linked') });
  const sent = await linked.agentSend({ imagePaths: [path.join(base, 'linked', 'a.png')] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.imageInputs, 1);
});

test('"cd /" with images moves no folder, and the paths are checked against the folder before it', async (t) => {
  const relay = boot(t);
  const outside = relay.write('b.png', pngBytes(8, 8), relay.dirs.outside);
  assertRefused(await relay.agentSend({ text: 'cd /', imagePaths: [outside] }), /outside this session's folder/);
  const inside = relay.write('a.png');
  const sent = await relay.agentSend({ text: 'cd /', imagePaths: [inside] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.workspaceRootChanged, false);
  assert.deepEqual(relay.workspaceCalls, []);
});

test('with the session folder at "/" the relay\'s data, uploads and session-state files stay refused', async (t) => {
  // The root of the temp tree's own drive: "/" on POSIX, the drive's root on
  // Windows (a bare "/" there is the current drive's, maybe another one).
  const relay = boot(t, { cwd: (dirs) => path.parse(dirs.outside).root });
  const data = relay.write('oar.db', pngBytes(8, 8), relay.dirs.data);
  const upload = relay.write('f'.repeat(64), pngBytes(9, 9), relay.dirs.uploads);
  const state = relay.write(path.join('sdk-1', 'notes.png'), pngBytes(8, 8), relay.dirs.state);
  assertRefused(await relay.agentSend({ imagePaths: [data] }), /own data/);
  assertRefused(await relay.agentSend({ imagePaths: [upload] }), /own data/);
  assertRefused(await relay.agentSend({ imagePaths: [state] }), /session-state folder/);
  const outside = relay.write('b.png', pngBytes(8, 8), relay.dirs.outside);
  assert.equal((await relay.agentSend({ imagePaths: [outside] })).status, 200);
});

test('another session\'s generated image may be attached; a lookalike folder, .. and a deleted session\'s may not', async (t) => {
  const relay = boot(t);
  seedConversation(relay.db, 'conv-b');
  seedConversation(relay.db, 'conv-archived', { archived: 1 });
  seedConversation(relay.db, 'conv-gone', { status: 'deleted' });
  const generated = (conversation, folder = 'generated-images') => relay.write(path.join('sdk-x', folder, conversation, 'msg-1', 'img-01.png'), pngBytes(8, 8), relay.dirs.state);
  const other = generated('conv-b');
  const sent = await relay.agentSend({ imagePaths: [other] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(relay.assets(sent.body.messageId).length, 1);
  assert.equal((await relay.agentSend({ imagePaths: [generated('conv-archived')] })).status, 200);
  assertRefused(await relay.agentSend({ imagePaths: [generated('conv-gone')] }), /session that is gone/);
  assertRefused(await relay.agentSend({ imagePaths: [generated('conv-b', 'generated-images-evil')] }), /session-state folder/);
  // path.join would take the .. out: the path is given as an agent might.
  const generatedDir = path.join(relay.dirs.state, 'sdk-x', 'generated-images', 'conv-b', 'msg-1');
  assertRefused(await relay.agentSend({ imagePaths: [`${generatedDir}/../msg-1/img-01.png`] }), /\. or \.\. segments/);
  assertRefused(await relay.agentSend({ imagePaths: [`${generatedDir}/../../../../../outside/b.png`] }), /\. or \.\. segments/);
});

test('the type is the bytes\' own: a .png that is a JPEG goes as JPEG, even over an upload stored as octet-stream', async (t) => {
  const relay = boot(t);
  const bytes = jpegBytes(20, 10);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  relay.stmts.insertUploadFile.run(sha256, 'blob', 'application/octet-stream', bytes.length, NOW);
  const file = relay.write('photo.png', bytes);
  const sent = await relay.agentSend({ imagePaths: [file] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const [asset] = relay.assets(sent.body.messageId);
  assert.equal(asset.media_type, 'image/jpeg');
  assert.equal(asset.content_sha256, sha256);
});

test('the same image named twice, through a link or as a copy, is attached once', { skip: process.platform === 'win32' }, async (t) => {
  const relay = boot(t);
  const first = relay.write('a.png', pngBytes(8, 8));
  const copy = relay.write('copy.png', pngBytes(8, 8));
  const second = relay.write('b.png', pngBytes(9, 9));
  fs.symlinkSync(first, path.join(relay.dirs.project, 'link.png'));
  const sent = await relay.agentSend({ imagePaths: [second, first, first, path.join(relay.dirs.project, 'link.png'), copy] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.imageInputs, 2);
  assert.equal(sent.body.imageInputsDropped, 3);
  assert.match(sent.body.imageInputsNote, /attached once/);
  // The first named is the base.
  assert.deepEqual(relay.assets(sent.body.messageId).map((asset) => asset.original_name), ['b.png', 'a.png']);
});

test('more than four images with the message\'s other attachments are refused', async (t) => {
  const relay = boot(t);
  const files = [1, 2, 3].map((index) => relay.write(`p${index}.png`, pngBytes(8 + index, 8)));
  const other = (index) => {
    const sha256 = String(index).repeat(64);
    relay.stmts.insertUploadFile.run(sha256, `o${index}.png`, 'image/png', 10, NOW);
    return { name: `o${index}.png`, type: 'image/png', sha256 };
  };
  assertRefused(await relay.agentSend({ imagePaths: files, attachments: [other(1), other(2)] }), /at most 4 images; this one would have 5/);
  assert.deepEqual(relay.counts(), { ...NOTHING, uploads: 2 });
  const fine = await relay.agentSend({ imagePaths: files, attachments: [other(1)] });
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  const stored = JSON.parse(relay.db.prepare('SELECT attachments FROM messages WHERE id = ?').get(fine.body.messageId).attachments);
  assert.deepEqual(stored.map((entry) => entry.name), ['p1.png', 'p2.png', 'p3.png', 'o1.png']);
});

test('images or image options for a session that makes no images are refused, nothing stored', async (t) => {
  const chat = boot(t, { model: 'gpt-5' });
  const file = chat.write('a.png');
  assertRefused(await chat.agentSend({ imagePaths: [file] }), /go to an OpenAI image session; this session runs gpt-5/);
  assertRefused(await chat.agentSend({ image: { size: '1024x1024' } }), /this session runs gpt-5/);
  assert.deepEqual(chat.counts(), NOTHING);
  // An image model named in the image options' wrong family is refused too.
  const dalle = boot(t, { model: 'dall-e-3' });
  assertRefused(await dalle.agentSend({ image: { count: 2 } }), /count must be a whole number from 1 to 1 for dall-e-3/);
});

test('a Copilot chat on an image id is refused with a pointer to OpenAI Image, from the composer too', async (t) => {
  const relay = boot(t, { provider: 'github', model: 'gpt-image-1' });
  const sent = await relay.send({ model: 'gpt-image-1' });
  assert.equal(sent.status, 400);
  assert.equal(sent.body.code, 'IMAGE_MODEL_NEEDS_OPENAI');
  assert.match(sent.body.error, /start an OpenAI Image chat \(provider openai\) for it\. Nothing was sent\./);
  assert.deepEqual(relay.counts(), NOTHING);
});

test('the operation\'s options are the session defaults under the turn\'s own, count from the turn', async (t) => {
  const relay = boot(t);
  relay.stmts.writeConversationImageDefaults(CONV, { size: '1536x1024', quality: 'low', output_format: 'webp' });
  const sent = await relay.agentSend({ image: { count: 3, quality: 'high' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(JSON.parse(relay.operation(sent.body.messageId).parameters_json), {
    count: 3, output_format: 'webp', quality: 'high', size: '1536x1024',
  });
  assert.deepEqual(sent.body.imageOptions, { size: '1536x1024', quality: 'high', output_format: 'webp', count: 3 });
  // An agent's effort counts below the defaults.
  const withEffort = await relay.agentSend({ reasoningEffort: 'medium' });
  assert.equal(JSON.parse(relay.operation(withEffort.body.messageId).parameters_json).quality, 'low');
  // The composer's own quality and size are the turn's own.
  const composer = await relay.send({ text: 'a lighthouse', reasoningEffort: 'medium', contextTier: '1024x1024' });
  assert.deepEqual(JSON.parse(relay.operation(composer.body.messageId).parameters_json), {
    count: 1, output_format: 'webp', quality: 'medium', size: '1024x1024',
  });
  // Without defaults a composer turn runs as before.
  const plain = boot(t);
  const before = await plain.send({ text: 'a lighthouse', reasoningEffort: 'auto', contextTier: 'auto' });
  assert.deepEqual(JSON.parse(plain.operation(before.body.messageId).parameters_json), { count: 1, quality: 'auto', size: 'auto' });
});

test('the composer\'s image body: a custom size, count, format and background reach the operation', async (t) => {
  const relay = boot(t);
  // As the composer sends it: contextTier carries the resolved size too.
  const sent = await relay.send({
    text: 'a lighthouse at dusk',
    reasoningEffort: 'high',
    contextTier: '1536x512',
    image: { size: '1536x512', quality: 'high', count: 2, output_format: 'webp', background: 'opaque' },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(JSON.parse(relay.operation(sent.body.messageId).parameters_json), {
    background: 'opaque', count: 2, output_format: 'webp', quality: 'high', size: '1536x512',
  });
  // A size the model does not take is refused, nothing queued.
  const before = relay.counts();
  const refused = await relay.send({ text: 'too wide', contextTier: '1552x512', image: { size: '1552x512' } });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /aspect ratio/);
  assert.deepEqual(relay.counts(), before);
});

test('without image continuity the worker gets the turn\'s options as imageOptions', async (t) => {
  const relay = boot(t, { continuity: false });
  relay.stmts.writeConversationImageDefaults(CONV, { size: '1536x1024' });
  const file = relay.write('a.png');
  const sent = await relay.agentSend({ imagePaths: [file], image: { count: 2, background: 'transparent' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(relay.operation(sent.body.messageId), undefined);
  const row = relay.stmts.findQById.get(sent.body.messageId);
  const message = buildDequeuedRelayMessage({
    msg: row,
    stmts: relay.stmts,
    parseAttachments: (raw) => JSON.parse(raw || '[]'),
    ensureRuntimeSessionBinding: () => relay.stmts.getRuntimeSessionByConversation.get(CONV),
    configuredConversationSessionMode: 'isolated',
    normalizeRelayMode: (value) => value,
    defaultRelayMode: 'agent',
    defaultModel: 'gpt-5',
  });
  assert.deepEqual(message.imageOptions, { size: '1536x1024', count: 2, background: 'transparent' });
  assert.equal(message.attachments[0].type, 'image/png');
  assert.ok(message.attachments[0].sha256);
});

test('an agent\'s image turn ignores @file: tokens; the owner\'s keeps them', async (t) => {
  const reference = { name: 'ref.png', type: 'image/png', path: '/home/dev/project/ref.png', source: 'reference' };
  const relay = boot(t, { references: [reference] });
  const agent = await relay.agentSend({ text: 'use @file:ref.png' });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal(agent.body.ignoredReferenceAttachments, 1);
  assert.equal(agent.body.referenceAttachmentCount, 0);
  assert.equal(relay.db.prepare('SELECT attachments FROM messages WHERE id = ?').get(agent.body.messageId).attachments, null);
  const owner = await relay.send({ text: 'use @file:ref.png again' });
  assert.equal(owner.body.referenceAttachmentCount, 1);
  assert.equal(owner.body.ignoredReferenceAttachments, undefined);
});

test('imagePaths that is not a list of paths, and imagePaths for a new conversation, are refused', async (t) => {
  const relay = boot(t);
  assertRefused(await relay.agentSend({ imagePaths: 'a.png' }), /must be a list/);
  assertRefused(await relay.agentSend({ imagePaths: [42] }), /must be a list/);
  const fresh = await relay.send({ conversationId: undefined, newConversation: true, providerType: 'openai', model: 'gpt-image-2', imagePaths: [relay.write('a.png')] });
  assertRefused(fresh, /need an existing session/);
  // An empty list is no image: the send goes on and says so.
  const none = await relay.agentSend({ imagePaths: [] });
  assert.equal(none.status, 200);
  assert.equal(none.body.imageInputs, 0);
});

test('xhigh and max are checked against the session\'s model at send time, before anything is queued', async (t) => {
  // gpt-image-2 takes up to high: refused, nothing queued.
  const older = boot(t, { model: 'gpt-image-2' });
  const before = older.counts();
  const refused = await older.agentSend({ image: { quality: 'xhigh' } });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'IMAGE_INPUT_REFUSED');
  assert.match(refused.body.error, /quality must be one of: auto, low, medium, high for gpt-image-2 \(xhigh and max: the gpt-image 2\.5 and 2\.6 models only\)/);
  assert.deepEqual(older.counts(), before);
  // Under the pixel floor of gpt-image-2: refused with both numbers.
  const small = await older.agentSend({ image: { size: '640x1008' } });
  assert.equal(small.status, 400);
  assert.match(small.body.error, /640x1008: gpt-image-2 takes 655360 to 8294400 pixels/);

  // A 2.5 model takes them; the composer names high as its effort and max as the image's quality.
  const newer = boot(t, { model: 'gpt-image-2.5-flare' });
  const agent = await newer.agentSend({ image: { quality: 'xhigh', size: '1024x1024' } });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal(JSON.parse(newer.operation(agent.body.messageId).parameters_json).quality, 'xhigh');
  const composer = await newer.send({ text: 'a lighthouse', reasoningEffort: 'high', contextTier: '1024x1024', image: { size: '1024x1024', quality: 'max' } });
  assert.equal(composer.status, 200, JSON.stringify(composer.body));
  assert.equal(JSON.parse(newer.operation(composer.body.messageId).parameters_json).quality, 'max');
});
