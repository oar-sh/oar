# Remote access

Reaching the relay from your phone or another network, through a managed tunnel. This is the detail behind the [README](../README.md#remote-access); the most complete guide is [Remote access on oar.sh](https://oar.sh/docs/remote-access/).

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

The relay auto-reconnects tunnel drops with exponential backoff.

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
