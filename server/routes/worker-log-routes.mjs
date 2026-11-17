'use strict';

// GET /api/conversation/:conversationId/worker-log — the end of a
// conversation's worker log for the worker log view, and for the
// conversation's own agent (relay_tool read_worker_log on relay "this").
// Without `before`: the last `lines` lines (default 2,000, at most 5,000)
// within 256 KB; with `before` (a startOffset of an earlier answer): the
// lines ending there. Every window is cleaned (control codes out, colours
// kept, credentials scrubbed) on the server; nothing raw leaves, and there
// is no download.
//
// Who may read it: the person, and an agent token only for its own
// conversation. Another conversation's agent, the cli token and a request
// another relay sent are refused here; a paired relay's key is refused by
// the route policy (REMOTE_RELAY_PEER_SCOPE). The log holds a whole
// conversation's trail and raw provider output, so it is narrower than the
// task output route.

import { AUTH_ERROR_CODES, AUTH_PERSON_REQUIRED_MESSAGE } from '../../shared/relay-route-policy.mjs';
import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { agentConversationOf, isAgent, notPerson } from '../services/relay-principal.mjs';
import {
  previousWorkerLogs,
  readWorkerLogBefore,
  readWorkerLogTail,
  resolveWorkerLog,
} from '../services/worker-log-service.mjs';

export const WORKER_LOG_ROUTE = '/api/conversation/:conversationId/worker-log';

export const WORKER_LOG_MESSAGES = Object.freeze({
  noSession: 'No worker log yet: this conversation has not started a worker.',
  missing: 'No worker log yet: the worker has not written to its log file.',
  otherConversation: 'A worker log is read only by its own conversation\'s agent (or the user in the relay UI).',
});

const UNREADABLE_MESSAGES = Object.freeze({
  symlink: 'The worker log is a symbolic link; it is not read.',
  'not-file': 'The worker log is not a regular file; it is not read.',
  'invalid-path': 'The worker log\'s path is not usable.',
});

export function registerWorkerLogRoutes(app, deps) {
  const {
    auth,
    // (conversationId) => the conversation row, any status, or null.
    getConversation = () => null,
    // (conversationId) => its provider ('claude', 'github', ...) or ''.
    providerOf = () => '',
    // The environment the workers are launched with: where their logs go.
    getLaunchEnv = () => process.env,
    remoteRelayInbound = null,
  } = deps;

  app.get(WORKER_LOG_ROUTE, auth, async (req, res) => {
    res.setHeader?.('Cache-Control', 'no-store');
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    // The person in this relay's page; an agent only for its own conversation.
    if (notPerson(req, readRemoteRelayRequest(req, remoteRelayInbound || {}))) {
      const own = isAgent(req) ? agentConversationOf(req) : '';
      if (!own) return res.status(403).json({ error: AUTH_PERSON_REQUIRED_MESSAGE, code: AUTH_ERROR_CODES.personRequired });
      if (own !== conversationId) {
        return res.status(403).json({ error: WORKER_LOG_MESSAGES.otherConversation, code: AUTH_ERROR_CODES.conversationMismatch });
      }
    }
    let conversation = null;
    try {
      conversation = getConversation(conversationId) || null;
    } catch {}
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const { dir, path, sdkSessionId } = resolveWorkerLog(conversation, getLaunchEnv() || {});
    let provider = '';
    try {
      provider = String(providerOf(conversationId) || '');
    } catch {}
    const head = { ok: true, conversationId, provider, sdkSessionId, dir, path };
    if (!path) return res.json({ ...head, kind: 'none', previous: [], message: WORKER_LOG_MESSAGES.noSession });
    const previous = await previousWorkerLogs(path);

    const before = req.query?.before;
    const lines = req.query?.lines;
    const read = before !== undefined && before !== ''
      ? await readWorkerLogBefore(path, { before, lines })
      : await readWorkerLogTail(path, { lines });
    if (!read.ok) {
      if (read.code === 'missing') return res.json({ ...head, kind: 'none', previous, message: WORKER_LOG_MESSAGES.missing });
      return res.status(409).json({
        error: UNREADABLE_MESSAGES[read.code] || 'The worker log cannot be read now.',
        code: read.code || 'unreadable',
      });
    }
    const { ok: _ok, ...window } = read;
    return res.json({ ...head, kind: 'file', previous, ...window });
  });
}
