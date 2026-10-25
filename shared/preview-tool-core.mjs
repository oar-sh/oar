// The provider-facing definition of the preview capability, in one place.
//
// Two consumption modes, one source of truth:
//  - Providers with a custom-tool surface (Claude via SDK MCP server, Cursor via
//    customTools) register `{ name, description, inputSchema, execute }` built
//    from these exports.
//  - Providers without one (Copilot CLI, Grok) get renderPreviewInstructionBlock(),
//    which teaches the identical HTTP API and is generated from the same strings —
//    the tool and the instructions cannot drift apart.
//
// SDK-free and dependency-injected, following ask-user-bridge.mjs: all relay
// traffic goes through the worker's injected `api(method, path, body)` helper.

export const PREVIEW_TOOL_NAME = 'preview';

export const PREVIEW_TOOL_DESCRIPTION =
  'Publish a local web server or a static directory on a public preview URL so '
  + 'the user can open it from any device, or list/close this conversation\'s '
  + 'previews. Use this whenever the user wants to see, try, or share something '
  + 'with a web UI — never ask them to open localhost or forward a port. '
  + 'For a dev server: call this FIRST with {action:"create", port} to get the '
  + 'basePath, then start the server configured to serve under that basePath '
  + '(Vite --base, Next basePath, Express mount prefix); the proxy forwards '
  + 'X-Forwarded-Prefix but does not rewrite bodies, so root-absolute asset '
  + 'paths will not work. For plain files or a build output: pass {action:'
  + '"create", dir} instead and the relay serves the directory itself — no dev '
  + 'server needed. Always tell the user the returned URL and that the link is '
  + 'public: anyone who has it can reach the app without logging in. Publishing '
  + 'the same port or directory again in this conversation returns the same '
  + 'link. Previews never expire and survive a relay restart (a port preview '
  + 'until the machine reboots); close them with {action:"close"} when the user '
  + 'is done.';

export const PREVIEW_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'list', 'close'],
      description: 'create: publish a port or directory. list: this conversation\'s live previews. close: unpublish one of them.',
    },
    port: {
      type: 'integer',
      minimum: 1024,
      maximum: 65535,
      description: 'create only: local port an already-listening dev server is on. Mutually exclusive with dir.',
    },
    dir: {
      type: 'string',
      description: 'create only: directory to serve statically (absolute, or relative to the workspace root). Mutually exclusive with port.',
    },
    label: {
      type: 'string',
      maxLength: 120,
      description: 'create only: short human label shown on the preview card, e.g. "web app (vite)".',
    },
    token: {
      type: 'string',
      pattern: '^[0-9a-f]{32}$',
      description: 'close only: which preview. May be omitted when exactly one preview is live in this conversation.',
    },
  },
  required: ['action'],
};

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * Validates and normalizes tool input. This is a courtesy layer so the model
 * gets a crisp message instead of an HTTP 400 — the API performs the same
 * checks authoritatively.
 */
export function validatePreviewToolInput(input = {}) {
  const action = toText(input?.action).toLowerCase();
  if (!['create', 'list', 'close'].includes(action)) {
    return { ok: false, error: 'action must be one of: create, list, close' };
  }
  if (action === 'create') {
    const hasPort = input?.port !== undefined && input?.port !== null && toText(input?.port) !== '';
    const dir = toText(input?.dir);
    if (hasPort && dir) {
      return { ok: false, error: 'Pass either port (proxy a running server) or dir (serve files statically), not both' };
    }
    if (!hasPort && !dir) {
      return { ok: false, error: 'create needs a port (running dev server) or a dir (static files)' };
    }
    if (hasPort) {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return { ok: false, error: 'port must be an integer between 1024 and 65535' };
      }
      return { ok: true, action, port, label: toText(input?.label).slice(0, 120) };
    }
    return { ok: true, action, dir, label: toText(input?.label).slice(0, 120) };
  }
  if (action === 'close') {
    const token = toText(input?.token).toLowerCase();
    if (token && !/^[0-9a-f]{32}$/.test(token)) {
      return { ok: false, error: 'token must be the 32-hex preview token from create/list' };
    }
    return { ok: true, action, token: token || null };
  }
  return { ok: true, action };
}

/**
 * Executes a validated call against the relay API. Returns a compact object the
 * model can quote directly; errors come back as `{ ok:false, error }` rather
 * than throws, so a refused create reads as an answer, not a tool crash.
 */
export async function executePreviewTool(input, { api, conversationId = '' } = {}) {
  if (typeof api !== 'function') return { ok: false, error: 'Preview API unavailable in this worker' };
  const parsed = validatePreviewToolInput(input);
  if (!parsed.ok) return parsed;
  // list and close reach only this conversation's previews: a preview's token
  // is its only credential. The relay enforces the same scope for every
  // request that names a conversation (routes/preview-routes.mjs). A create
  // without one would land in no conversation's scope, so it is refused too.
  const conversation = toText(conversationId);
  const scope = `conversationId=${encodeURIComponent(conversation)}`;
  if (!conversation) {
    return { ok: false, error: 'This tool call is not bound to a conversation; it cannot publish, list or close previews' };
  }

  try {
    if (parsed.action === 'list') {
      const response = await api('GET', `/api/previews?${scope}`);
      return {
        ok: true,
        enabled: response?.enabled === true,
        previews: (response?.previews || []).map((entry) => ({
          token: entry.token,
          label: entry.label,
          url: entry.url,
          target: entry.mode === 'static' ? entry.rootDir : `localhost:${entry.targetPort}`,
          online: entry.online,
          conversationId: entry.conversationId,
          // Stored but not served: the relay could not check it after a
          // restart and tries again. It can be closed.
          ...(entry.unverified === true ? { unverified: true } : {}),
        })),
      };
    }

    if (parsed.action === 'close') {
      let token = parsed.token;
      if (!token) {
        const response = await api('GET', `/api/previews?${scope}`);
        const live = response?.previews || [];
        if (live.length === 0) return { ok: false, error: 'No live previews in this conversation' };
        if (live.length > 1) {
          return {
            ok: false,
            error: 'Multiple previews are live; pass the token of the one to close',
            previews: live.map((entry) => ({ token: entry.token, label: entry.label })),
          };
        }
        token = live[0].token;
      }
      // Another conversation's token is refused by the relay (403); its
      // message comes back as the answer.
      const response = await api('DELETE', `/api/previews/${token}?${scope}`);
      return { ok: true, closed: { token, label: response?.preview?.label || null } };
    }

    const body = {
      conversationId: conversation,
      label: parsed.label || undefined,
      ...(parsed.port ? { port: parsed.port } : { dir: parsed.dir }),
    };
    const response = await api('POST', '/api/previews', body);
    const existing = response?.existing === true;
    const hint = parsed.port
      ? `Serve the app under ${response?.basePath} (the proxy strips the prefix and sends X-Forwarded-Prefix). Bind the dev server to 127.0.0.1, not 0.0.0.0: the relay's proxy reaches it there and nothing else should. Tell the user the URL and that the link is public.`
      : 'The directory is served as-is; relative asset paths work, root-absolute ones do not. Tell the user the URL and that the link is public.';
    return {
      ok: true,
      existing,
      url: response?.url,
      basePath: response?.basePath,
      token: response?.preview?.token,
      mode: response?.preview?.mode || (parsed.port ? 'port' : 'static'),
      hint: existing
        ? `This conversation already publishes this ${parsed.port ? 'port' : 'directory'}: same link as before, label unchanged. ${hint}`
        : hint,
    };
  } catch (error) {
    // A scope refusal (403) in its own words, without the HTTP wrapper.
    const refusal = Number(error?.status) === 403 ? toText(error?.detail) : '';
    return { ok: false, error: refusal || String(error?.message || error) };
  }
}

/**
 * The instruction block for providers without a custom-tool surface. Generated
 * from the same description/schema strings the tool uses; keep any wording
 * change up in the constants, never here. `conversationId` is the conversation
 * the block is sent to: written into every call, so the model's natural call
 * is the scoped one (without it, a plain GET would list the whole relay).
 */
export function renderPreviewInstructionBlock({ publicBaseUrl = '', conversationId = '' } = {}) {
  const base = toText(publicBaseUrl) || 'https://<preview-host>';
  const id = toText(conversationId);
  const conv = id ? JSON.stringify(id).slice(1, -1) : '<conv>';
  const convQuery = id ? encodeURIComponent(id) : '<conv>';
  return `## Preview servers

${PREVIEW_TOOL_DESCRIPTION}

There is no \`${PREVIEW_TOOL_NAME}\` tool on this provider — use the authenticated localhost API (same auth as /api/relay/shutdown):

- Publish a running dev server: \`POST /api/previews\` with \`{ "conversationId": "${conv}", "port": 5173, "label": "web app" }\` → \`{ "url": "${base}/test_<token>/", "basePath": "/test_<token>/" }\`. Register FIRST, then start the server under the returned basePath.
- Publish files without a server: \`POST /api/previews\` with \`{ "conversationId": "${conv}", "dir": "./dist", "label": "built site" }\` — the relay serves the directory itself. \`dir\` must live inside the conversation's workspace root.
- List this conversation's previews: \`GET /api/previews?conversationId=${convQuery}\`. Close one: \`DELETE /api/previews/:token?conversationId=${convQuery}\` — closes the link only, never the dev server behind it. Always pass the conversation: you may list and close only this conversation's previews, another conversation's is refused (403), and the relay-wide list is the user's (Settings → Previews).

A 503 with \`details\` means the preview lane is disabled or misconfigured — surface those details to the user. A 400 names exactly what was refused (relay-owned port, non-loopback host, dir outside the workspace root).`;
}
