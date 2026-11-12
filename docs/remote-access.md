# Remote access

Reaching the relay from your phone or another network, through a managed tunnel. This is the detail behind the [README](../README.md#remote-access); the most complete guide is [Remote access on oar.sh](https://oar.sh/docs/remote-access/).

Once your phone reaches the relay, sign it in without typing the relay token: **Settings → Security → Sign in another device** on a browser that is signed in makes a link that works once, for 10 minutes, and shows its QR code after a tap on **Show QR code** (see [the web UI](web-ui.md#security)). In a terminal on the relay host, `oar url --sign-in` prints such a link and QR code for the address a phone reaches.

Two relays reached under the same host name with different ports (`host:3333`, `host:3334`) share one sign-in cookie in a browser and sign each other out; give each its own host name (a tunnel each, or `localhost` for one and `127.0.0.1` for the other).

`localhostOnly` controls only the relay's own listener (`127.0.0.1` vs `0.0.0.0`). To reach the relay from outside your network, prefer one of the two managed tunnels below over opening a port. They are independent and can run at the same time.

## Optional remote internet access (SSH tunnel)

*On oar.sh: [SSH tunnel](https://oar.sh/docs/remote-access/ssh-tunnel/)*

Configure:

```json
"sshTunnel": {
  "mode": "managed",
  "required": false,
  "remoteBind": "loopback",
  "user": "ubuntu",
  "host": "relay.example.com",
  "remotePort": 4444,
  "identityFile": "~/.ssh/id_rsa"
}
```

SSH tunnel exposure is controlled by `sshTunnel.remoteBind`, independently of `localhostOnly`.

Then reverse proxy on the VPS (example Caddy):

```text
relay.example.com {
    reverse_proxy localhost:4444
}
```

The relay runs `ssh -N -R` in batch mode, so the key must work without a password prompt (a key
without passphrase, or one your SSH agent holds), and it accepts the server's host key on the first
connection. It auto-reconnects tunnel drops with exponential backoff. When the server refuses the
forward because `remotePort` is taken, the relay logs in, tries to stop a listener of your user that
holds it, and retries (`sshTunnel.autoReclaimPort`, on by default). A port still held by a dropped
earlier `ssh -R` session is freed only with `sshTunnel.reclaimStaleSshSessions: true`; otherwise
the relay keeps retrying with backoff (see the
[configuration reference](configuration.md#configuration-reference-serverconfigjson)).

## Optional remote internet access (Cloudflare Tunnel)

*On oar.sh: [Cloudflare Tunnel](https://oar.sh/docs/remote-access/cloudflare-tunnel/)*

An alternative to the SSH tunnel that needs no VPS and no inbound port: the relay
supervises Cloudflare's `cloudflared` binary, and Cloudflare carries your hostname down
to `127.0.0.1:3333`.

OAR does not include `cloudflared`; install it on the relay host first:

| System | Install |
| ------ | ------- |
| Windows | `winget install --id Cloudflare.cloudflared` |
| macOS | `brew install cloudflared` |
| Linux | Cloudflare's package repository (Debian, Ubuntu, RHEL): [pkg.cloudflare.com](https://pkg.cloudflare.com/) |

1. In your own Cloudflare Zero Trust account, create a tunnel and route a public hostname on
   your zone to `http://localhost:3333` (or your `port`). That routing lives in Cloudflare, not
   on this machine.
2. Put the tunnel's token into the config and restart the relay (`oar restart`).

```json
"cloudflaredTunnel": {
  "mode": "managed",
  "required": false,
  "token": "<tunnel token>",
  "binary": "",
  "extraArgs": []
}
```

Environment overrides: `COPILOT_CLOUDFLARED_MODE`, `COPILOT_CLOUDFLARED_TOKEN`,
`COPILOT_CLOUDFLARED_BINARY`.

`localhostOnly` stays `true`: `cloudflared` connects outbound and nothing binds publicly.
The relay runs the `cloudflared` named in `cloudflaredTunnel.binary`, or else the one on
its `PATH`. When there is none, the relay starts as usual and the tunnel stays off: the
status dot's tooltip, `oar doctor` and the server log say that `cloudflared` is not
installed and how to install it. The relay looks again every minute and starts the tunnel
once `cloudflared` is there; restart the relay if it was installed into a folder that is
not on the relay's `PATH`. With `required: true` the queue stays paused for as long as
the tunnel is not connected, a missing `cloudflared` included. Connection drops reconnect with jittered exponential backoff,
and repeated fast exits (deleted tunnel or bad token) are reported as `auth-or-config`
instead of hammering Cloudflare.

The relay status dot turns **amber** while the Cloudflare tunnel is connected, so it is
obvious at a glance that the relay is reachable from the internet rather than only from
this machine. It stays green when no tunnel is configured and grey when the relay itself
is unreachable; a managed tunnel that has dropped, or could not start, keeps the dot green — the relay
still answers locally — and gives the reason in the tooltip.

## Behind a reverse proxy

The two tunnels above need no extra settings: `cloudflared` and the SSH tunnel reach the
relay over `127.0.0.1`, and by default (`trustProxy: "loopback"`) the relay trusts the
`X-Forwarded-*` headers of a peer on loopback.

A reverse proxy on another host (or in another container or VM) is a different peer. The
relay ignores its `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` until you
trust it, so every visitor would have the proxy's address (one sign-in lockout and one
access-log address for everyone), new share links would start with `http://` and the
`Host` the proxy sent, and the sign-in cookie would not be marked `Secure`. Set:

- `localhostOnly: false`, so the relay listens beyond loopback (keep the port closed to
  everything but the proxy);
- `trustProxy` to the proxy's address or subnet, or to the number of proxies in front of
  the relay (`1` for one);
- `allowedOrigins` to the public origin, when the proxy rewrites the `Host` header and sends
  no `X-Forwarded-Host`. The live Socket.IO channel accepts only the origin the browser
  addressed; without this the page loads but gets no live updates, and the relay log says
  `Refused a handshake from origin …`.

```json
{
  "localhostOnly": false,
  "trustProxy": "192.0.2.10",
  "allowedOrigins": ["https://relay.example.com"]
}
```

Restart the relay after editing the config. A proxy on the relay host itself needs neither
`trustProxy` nor `localhostOnly`; `allowedOrigins` only if it rewrites `Host`. Under a URL
subpath, set `remotePath` too (see the [configuration reference](configuration.md#configuration-reference-serverconfigjson)).

## Pairing relays across a tunnel or proxy

[Paired relays](agents-together.md#remote-relays) reach each other at the address each one has in
**Settings → Relays → Public address**: set it to the tunnel's or the proxy's public URL on both
relays before pairing. Pairing uses the other relay's token from its link once; from then on each
relay signs in to the other with a key of its own (OAR 0.9.27 or later on both), which opens only
the routes relays call each other on. A key is a bearer secret like the token, so the same rules
apply: `https://` (plain `http://` only on loopback and private ranges), no redirects followed. A
key is only ever sent to the address the receiving relay has stored for that relay, and checked
back there; when a relay's address changes (a new tunnel name, a moved proxy), or another relay
answers at it, the keys this relay gave it are revoked, nothing this relay holds for it (the key
it gave this relay, or a token) is sent anywhere, and no new key is issued until you confirm the new address in Settings → Relays,
then **Re-pair**.
Replacing a relay's token does not break a keyed pairing; a relay that still calls with the token
(an older OAR) needs the new pairing link.

## Session-worker path guard

*On oar.sh: [Security](https://oar.sh/docs/remote-access/security/)*

Any public tunnel forwards *every* path on the bound hostname to port `3333`, including
the internal session-worker WebSocket endpoints. Requests to those paths are rejected with
`403` on both the request and upgrade paths unless they come from the relay host itself
and no proxy forwarded them: the peer must be loopback, and the request must carry no edge
marker header (`cf-ray`, plus anything in `tunnelMarkerHeaders` or
`COPILOT_TUNNEL_MARKER_HEADERS`) and no `X-Forwarded-For`, `Forwarded` or `X-Real-IP`. Local
workers connect over `127.0.0.1` without any of these and are unaffected, and shared
conversation links keep working anonymously over the tunnel.

Shared links work unchanged through Cloudflare. Do not add a Cloudflare Cache Rule
covering `/api/shared/*` — shared views poll for liveness and an edge-cached response
would pin viewers to a stale snapshot. Likewise, a Cloudflare Access application over the
bound hostname breaks share links unless it bypasses `/shared/*` and `/api/shared/*`.
