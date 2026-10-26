# Preview servers

Publish a local dev server on a public URL so you can open it from a phone, send
it to someone, or point a webhook at it — without exposing the relay.

A preview is a token-addressed passthrough to a port that is *already listening*
on the relay host. The relay never starts, supervises or restarts your dev
server; that stays an ordinary backgrounded task with its own stop button.

## The isolation model, in one paragraph

Previews are served by a **second HTTP listener on its own loopback port**,
published on a **hostname of its own**. The relay's express app — `/api`,
socket.io, the SPA, `/shared/:token`, session-worker paths — is not mounted on
that port, so preview traffic cannot reach relay functionality: it does not
exist there. Because the hostname differs from the relay's, a previewed app's
JavaScript is also a different origin: it cannot send the relay's auth cookie,
cannot read any relay API response (the relay sends no CORS headers), and cannot
read the relay SPA's storage. Both controls are independent, and neither relies
on the other.

## Operator setup

Ships disabled. Three things to configure:

1. **A hostname you control**, separate from the relay's. It must differ by
   *hostname*, not just port — cookies ignore ports, so `relay.example.com:3334`
   would still share the relay's cookie. The relay refuses to start the lane if
   the hostnames match.
2. **A front proxy** pointing that hostname at the preview port.
3. **The `previews` config block.**

```jsonc
// server/config.json
{
  "publicHostnames": ["relay.example.com"],   // the relay's own public hostname(s)
  "previews": {
    "enabled": true,
    "port": 3334,                              // default: config.port + 1; 0 = ephemeral
    "bindHost": "127.0.0.1",
    "publicBaseUrl": "https://preview.example.com",
    "allowedTargetHosts": [],                  // extra upstreams beyond loopback
    "maxLive": 8
  }
}
```

Environment overrides: `COPILOT_PREVIEWS_ENABLED` (`1`/`true` or `0`/`false`),
`COPILOT_PREVIEWS_PORT`, `COPILOT_PREVIEWS_BIND_HOST`,
`COPILOT_PREVIEWS_PUBLIC_BASE_URL`, `COPILOT_PREVIEWS_ALLOWED_TARGET_HOSTS`
(comma-separated). `previews.allowPublicBind` and `previews.maxLive` are read
from the config file only.

`publicHostnames` is what the same-hostname interlock checks against, so list
every hostname the relay itself answers on.

### Front proxy — Caddy

```
preview.example.com {
    reverse_proxy 127.0.0.1:3334
}
```

### Front proxy — cloudflared

Add a second public hostname to the existing named tunnel (dashboard: *Public
Hostnames → Add*, or in `config.yml`):

```yaml
ingress:
  - hostname: preview.example.com
    service: http://127.0.0.1:3334
  - hostname: relay.example.com
    service: http://127.0.0.1:3333
  - service: http_status:404
```

A single-label hostname under a zone you already have (`preview.example.com`) is
covered by Cloudflare's Universal certificate. A two-label wildcard
(`*.preview.example.com`) is not, and would need Advanced Certificate Manager —
which is why previews are namespaced by path rather than by subdomain.

### Startup interlocks

The lane refuses to come up — logging the reason and leaving the relay running
normally — if `publicBaseUrl` is missing or shares the relay's hostname, if the
port collides with the relay or CLI port, or if `bindHost` is non-loopback
without `previews.allowPublicBind`. Each one is load-bearing for the isolation
argument, so none of them degrade to a warning.

## Using a preview

Three ways in, all backed by the same API:

1. **Ask the agent.** "Show me a preview of this" / "start the dev server and host
   it". Claude, Claude API and Cursor sessions have a first-class `preview`
   tool, and so do Grok and Copilot's Extension engine, through OAR's MCP
   server (unless the relay runs with `OAR_MCP_SERVER=0`). Copilot's SDK
   engine, and the other two without the MCP server, are taught the HTTP API
   through injected instructions. Tool and instructions drive the same API,
   so the semantics are identical.
2. **`/preview` in the composer.** Client-side, works on every provider, costs no
   agent turn:

   ```
   /preview 5173 web app        publish a port
   /preview ./dist built site   publish a directory (static mode)
   /preview list                list live previews
   /preview close [prefix]      close one (no arg + one live preview → close it)
   ```

3. **The API directly** — register **first** so you know the base path, then
   start the dev server with it:

```bash
curl -sX POST http://127.0.0.1:3333/api/previews \
  -H "authorization: Bearer $RELAY_TOKEN" -H 'content-type: application/json' \
  -d '{"conversationId":"<conv>","port":5173,"label":"web app"}'
# → {"url":"https://preview.example.com/test_<token>/","basePath":"/test_<token>/"}

npm run dev -- --base=/test_<token>/
```

A card appears in the conversation's background-task panel with **Open**, **Copy
link** and **Close**; the settings modal's *Live previews* section lists every
preview across all sessions, with when it was published and last opened.

An agent sees only its own conversation's previews: the tool's `list` shows
them and nothing else, and its `close` refuses another conversation's preview
with a 403 that says so. Agents that use the HTTP API instead of a tool
(Copilot, and Grok without the tool server) are taught the same calls with
their conversation already written in. The relay-wide view is yours, in
Settings → Previews (and `/preview list`). The relay enforces the scope on
every request that names a conversation — the `conversationId` query, or the
`X-Relay-Conversation-Id` header every session worker and the agents' tool
server send; a conversation's id and its session id count as the same
conversation.

Known limit: agents authenticate with the same relay token as you do, so
the scope is declared by the request, not proven. A request that names no
conversation still gets the relay-wide answer, and one can name any
conversation. The scope keeps the tools and the taught calls
honest; it is not a wall against an agent that reads the relay token and
calls the API by hand.

Previews never expire, and they survive a relay restart (an update, a queued
restart, a crash): the relay keeps them in its database and restores them when
it starts, so a link you handed out keeps working. A preview ends when you
close it, when you delete its conversation (archiving keeps it), or when a
restart finds it no longer valid:

- a **folder** preview whose folder is gone or no longer inside its
  conversation's workspace root;
- a **port** preview after the machine rebooted — the dev server is gone then,
  and the port may later belong to something else;
- a preview whose conversation no longer exists.

"Rebooted" means a new boot of the kernel. Linux and macOS report one
reliably. Windows has no such id, so the relay compares the boot time derived
from the uptime: a **Restart** counts as a reboot, but with *fast startup* on
(the default) **Shut down** and power-on resume the hibernated kernel and keep
the uptime, so a port preview from before comes back and reaches whatever
listens on its port then.

A check that cannot answer — the database is busy, the folder cannot be read
for a reason other than being gone — does not end the preview; the log says
so. The preview is not served meanwhile: Settings → Previews and the tool's
`list` show it as not served (`unverified`), it counts towards the limit, and
it can be closed. The relay checks it again every 15 s and brings it back
under its link as soon as the check answers; publishing the same port or
folder again in its conversation does the same at once, unless the conversation
is gone. A preview that still cannot be checked after ten minutes is ended,
and the log says so.

A write to the database that fails is retried (every 15 s and at shutdown), so
a closed preview does not come back and a new one is not lost. While the
database stays locked the relay waits on it once per round, and a shutdown
waits a quarter of a second on it at most. If the relay's database has a
`previews` table it cannot use, previews work as before this change — in
memory only, until a restart — and the log says so once.

Publishing the same port or folder again in the same conversation returns the
existing preview (same link, label unchanged) instead of a new one. At most
`previews.maxLive` (default 8) previews are live at once; the refusal names the
oldest ones and how to close them. A restart restores every stored preview even
after the limit was lowered; new ones are refused until enough are closed.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/previews` | `{conversationId?, port \| dir, host?, label?}` → `{url, basePath, preview, existing}` |
| `GET /api/previews` | All live previews; scoped to one conversation by `?conversationId=` or the `X-Relay-Conversation-Id` header |
| `DELETE /api/previews/:token` | Close one. The dev server is untouched. Scoped like `GET`: another conversation's preview is refused with 403 |

A preview published while an agent turn is running is also pinned into the
transcript as a compact link card on that response (it shows a `closed` badge
once the preview is gone). Manual `/preview` publishes stay panel-only. A
publicly shared transcript shows such a card with its label only — never the
token or the link — and every preview link quoted in it (reply text, thoughts,
tool lines, sub-agent runs) has its `test_<token>` part replaced by
`[preview link removed]`, also with the `_` written as `%5F`. A link may be
cut short — a reply still being written, a turn that failed inside it, a line
capped at a length — so the rule does not ask for a whole token: `test_`
followed by eight or more hex digits is replaced wherever it stands. At most
seven of a token's 32 characters can therefore remain, far too few to guess
the rest from. The bare token of any preview the relay knows, of whatever
conversation, is replaced as well, from its first eight characters on. The
price is small: a name such as `test_add` or `test_1` stays as written, and
only `test_` with eight or more hex digits behind it (`test_deadbeef`) shows
the replacement in a shared transcript.

## Static previews (`dir` instead of `port`)

`POST /api/previews {"dir": "./dist"}` serves the directory **in-process** — no
dev server, no `python -m http.server`, nothing left running. Use it for build
outputs, mockups, single HTML files, coverage reports.

- The directory is resolved against the conversation's workspace root and must
  live inside it (realpath-checked at registration and on every request, so
  symlinks cannot walk out — even ones created later).
- Dotfiles and dot-directories (`.git`, `.env`, …) are never served, nor are
  `*.pem`, `*.key`, or `id_rsa*`-style key files.
- `index.html` is served at directory paths; everything is `no-store`.
- Static previews are always `online` (there is no upstream to die) and refuse
  WebSocket upgrades.

Relative asset paths work as-is. Root-absolute ones (`/assets/app.js`) do not —
same subfolder-root contract as port previews.

All three require the relay token and are only on the relay port. The preview
listener itself has no management surface at all.

## Making an app work under a subfolder

Every preview shares one preview origin and is namespaced by `/test_<token>/`,
so the app has to know it lives under that prefix. The proxy passes
`X-Forwarded-Prefix`, `X-Forwarded-Host`, `X-Forwarded-Proto` and
`X-Forwarded-For`, rewrites `Location` headers on redirects, and scopes
`Set-Cookie` to the prefix — but it does **not** rewrite HTML, CSS or JS bodies.
An app that emits root-absolute asset paths (`/assets/app.js`) gets a 502
diagnostic page rather than a silently broken one.

**Vite**

```js
export default defineConfig({
  base: process.env.PREVIEW_BASE || '/',
  server: {
    hmr: { path: process.env.PREVIEW_BASE, clientPort: 443, protocol: 'wss' },
    allowedHosts: true,
  },
});
```

**Next.js** — `basePath` and `assetPrefix` in `next.config.js`, both set to the
prefix without its trailing slash.

**SvelteKit** — `kit.paths.base`.

**Plain Express** — mount the router: `app.use(process.env.PREVIEW_BASE || '/', router)`,
or trust `X-Forwarded-Prefix` directly.

**Wrangler / Workers** — `wrangler dev --port 8787`; either tolerate the prefix
in the router or strip it at the edge of your handler.

## What to keep in mind

- **The link is public.** The token (128 bits) is the only credential. Anyone
  who has the URL reaches the app — that is the point, but it means a preview of
  something with real data is a real exposure. Close it when you are done.
- **Previews share an origin with each other.** Cookies are scoped to each
  preview's path and tokens are unguessable, but two previews are not fully
  isolated from one another the way each is from the relay.
- **Loopback only, by default.** Targets must be on `127.0.0.0/8` or `::1`
  unless listed in `allowedTargetHosts`, and the relay's own ports are refused
  outright — publishing the relay port would put the relay UI on the public
  preview host.
- **`offline` is not `closed`.** A TCP probe every 15s (and once right after
  the relay starts) badges the card when the dev server stops answering; the
  token stays registered, so restarting on the same port revives the same URL.
- **A port link follows the port.** Until the machine reboots, a port preview
  reaches whatever listens on that port — also another app started there later.
  On Windows with fast startup, a shut-down and power-on is not a reboot (see
  above). Close previews you no longer need.
- **Logs name a preview by a short hash**, never by its token.
