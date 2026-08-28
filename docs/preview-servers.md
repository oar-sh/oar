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

Environment overrides: `COPILOT_PREVIEWS_ENABLED`, `COPILOT_PREVIEWS_PORT`,
`COPILOT_PREVIEWS_BIND_HOST`, `COPILOT_PREVIEWS_PUBLIC_BASE_URL`,
`COPILOT_PREVIEWS_ALLOWED_TARGET_HOSTS`.

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
   it". Claude and Cursor sessions have a first-class `preview` tool; Copilot CLI
   and Grok sessions are taught the HTTP API through injected instructions. Both
   come from `shared/preview-tool-core.mjs`, so the semantics are identical.
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
preview across all sessions. Previews never expire — they live until you close
one or the relay restarts.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/previews` | `{conversationId?, port \| dir, host?, label?}` → `{url, basePath, preview}` |
| `GET /api/previews` | All live previews; `?conversationId=` to filter |
| `DELETE /api/previews/:token` | Close one. The dev server is untouched. |

A preview published while an agent turn is running is also pinned into the
transcript as a compact link card on that response (it shows a `closed` badge
once the preview is gone). Manual `/preview` publishes stay panel-only.

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
- **`offline` is not `closed`.** A TCP probe every 15s badges the card when the
  dev server stops answering; the token stays registered, so restarting on the
  same port revives the same URL.
