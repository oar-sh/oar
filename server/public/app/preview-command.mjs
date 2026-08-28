// The /preview composer command: publish a port or directory, list, or close —
// entirely client-side against the relay API, so it works identically on every
// provider and never costs an agent turn. Mirrors the /compact intercept in
// conversation-view.js: parsed before anything is queued, unknown syntax falls
// through to a help line, never to the model.

import { apiFetch } from './api-client.js';

export const PREVIEW_COMMAND_HELP =
  'Usage: /preview <port> [label] · /preview <dir> [label] · /preview list · /preview close [token-prefix]';

/**
 * Returns null when the text is not a /preview command at all (the composer
 * sends it as a normal message); otherwise a parsed command, with unparseable
 * input mapped to {kind:'help'} so it never reaches the model by accident.
 */
export function parsePreviewCommand(text) {
  const trimmed = String(text || '').trim();
  if (!/^\/preview(\s|$)/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^\/preview\s*/i, '').trim();
  if (!rest) return { kind: 'help' };

  const [first, ...restParts] = rest.split(/\s+/);
  const remainder = restParts.join(' ').trim();

  if (/^list$/i.test(first)) return { kind: 'list' };
  if (/^close$/i.test(first)) {
    const prefix = remainder.toLowerCase();
    if (prefix && !/^[0-9a-f]{4,32}$/.test(prefix)) return { kind: 'help' };
    return { kind: 'close', tokenPrefix: prefix || null };
  }
  if (/^\d+$/.test(first)) {
    const port = Number(first);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: 'help' };
    return { kind: 'create-port', port, label: remainder || null };
  }
  // Anything path-shaped is a static preview. Windows drive letters ("C:\x")
  // and dotted relatives all land here; the server does the real validation.
  return { kind: 'create-dir', dir: first, label: remainder || null };
}

async function closeByPrefix(tokenPrefix, conversationId) {
  const listed = await apiFetch(`/api/previews${tokenPrefix ? '' : `?conversationId=${encodeURIComponent(conversationId || '')}`}`);
  const previews = listed?.previews || [];
  const matches = tokenPrefix
    ? previews.filter((entry) => String(entry.token || '').startsWith(tokenPrefix))
    : previews;
  if (matches.length === 0) {
    return { ok: false, notice: tokenPrefix ? `No preview matches "${tokenPrefix}".` : 'No live previews in this conversation.' };
  }
  if (matches.length > 1) {
    const names = matches.map((entry) => `${entry.token.slice(0, 8)} (${entry.label})`).join(', ');
    return { ok: false, notice: `Ambiguous — matches: ${names}. Use a longer prefix.` };
  }
  const closed = await apiFetch(`/api/previews/${encodeURIComponent(matches[0].token)}`, { method: 'DELETE' });
  if (closed?.ok !== true) return { ok: false, notice: 'Close failed — the preview may already be gone.' };
  return { ok: true, notice: `Preview closed: ${matches[0].label}` };
}

/**
 * Executes a parsed command. Returns `{ ok, notice }`; the caller renders the
 * notice. Creation results also surface as panel cards via the `previews`
 * socket event, so the notice only needs to carry the URL once.
 */
export async function runPreviewCommand(parsed, { conversationId = '' } = {}) {
  if (!parsed || parsed.kind === 'help') return { ok: true, notice: PREVIEW_COMMAND_HELP };

  try {
    if (parsed.kind === 'list') {
      const listed = await apiFetch('/api/previews');
      if (!listed) return { ok: false, notice: 'Could not reach the relay.' };
      if (listed.enabled !== true) return { ok: false, notice: 'The preview lane is disabled on this relay.' };
      const previews = listed.previews || [];
      if (!previews.length) return { ok: true, notice: 'No live previews.' };
      const lines = previews.map((entry) => {
        const target = entry.mode === 'static' ? entry.rootDir : `:${entry.targetPort}`;
        const state = entry.online === false ? ' — offline' : '';
        return `${entry.token.slice(0, 8)} · ${entry.label} (${target})${state} → ${entry.url}`;
      });
      return { ok: true, notice: lines.join('\n') };
    }

    if (parsed.kind === 'close') {
      return await closeByPrefix(parsed.tokenPrefix, conversationId);
    }

    const body = {
      conversationId: conversationId || undefined,
      label: parsed.label || undefined,
      ...(parsed.kind === 'create-port' ? { port: parsed.port } : { dir: parsed.dir }),
    };
    const created = await apiFetch('/api/previews', { method: 'POST', body: JSON.stringify(body) });
    if (created?.ok !== true) {
      // apiFetch swallows the response body on non-2xx, so the specific server
      // error (bad port, jail refusal, lane disabled) is not recoverable here;
      // point at the panel where the states are visible instead.
      return { ok: false, notice: 'Preview failed — check the port/path, or whether the preview lane is enabled (Settings → Live previews).' };
    }
    return { ok: true, notice: `Preview published: ${created.url}` };
  } catch {
    return { ok: false, notice: 'Preview command failed — could not reach the relay.' };
  }
}
