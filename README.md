# OAR — Open Agent Relay

Drive the coding agents on your machine from any browser (phone, tablet, or a second computer) through a self-hosted web relay.

```bash
curl -fsSL oar.sh/install | sh
```

On Windows, run `irm oar.sh/install.ps1 | iex` in PowerShell. Landing page: [oar.sh](https://oar.sh). npm and git-checkout installs are covered under [Install](#install).

OAR relays seven runtimes: **GitHub Copilot**, **OpenAI (BYOK)**, **OpenAI Image (BYOK)**, **Claude (Agent SDK)**, **Claude Cloud**, **Cursor (Agent SDK)**, and **Grok (CLI ACP)**. You pick one per conversation, and all of them share the same chat UI, queue, history, file browser, and question cards.

```text
                                             ┌── Copilot       SDK worker, or Copilot CLI + extension
                                             ├── OpenAI        Copilot runtime, your API key
                                             ├── OpenAI Image  Images API, called by the relay
[Browser] <--WebSocket--> [OAR relay :3333]  ┼── Claude        Agent SDK worker, host's Claude login
                                             ├── Claude Cloud  sandbox at Anthropic, host's Claude login
                                             ├── Cursor        Agent SDK worker, your Cursor API key
                                             └── Grok          Grok CLI over ACP, host's Grok login
```

The relay runs on your hardware, listens on localhost only until you change that, and collects no telemetry (see [Security notes](#security-notes)).

OAR is under active development, so expect occasional rough edges and some provider SDK features that are missing or incomplete.

## In action

<table>
<tr>
<td width="42%" rowspan="3" valign="top">
<a href="https://oar.sh/assets/shots/cfmail-mobile.png?v=0.9.3"><img src="https://oar.sh/assets/shots/cfmail-mobile.png?v=0.9.3" alt="OAR on a phone: a finished agent turn in a conversation, with the composer below"></a>
<br><sub>On a phone: the same conversations, installable as an app.</sub>
</td>
<td width="58%" valign="top">
<a href="https://oar.sh/assets/shots/cfmail-agents.png?v=0.9.3"><img src="https://oar.sh/assets/shots/cfmail-agents.png?v=0.9.3" alt="Background subagents running in parallel in the task panel, each with live token counts, elapsed time, and its own Stop button"></a>
<br><sub>Agents working in parallel, each with live token counts and its own Stop.</sub>
</td>
</tr>
<tr>
<td valign="top">
<a href="https://oar.sh/assets/shots/cfmail-question.png?v=0.9.3"><img src="https://oar.sh/assets/shots/cfmail-question.png?v=0.9.3" alt="A question card in the middle of a turn: the agent offers several choices and a free-text reply"></a>
<br><sub>When the agent needs a decision, it asks, and waits for your answer.</sub>
</td>
</tr>
<tr>
<td valign="top">
<a href="https://oar.sh/assets/shots/pingcf-thoughts.png?v=0.9.3"><img src="https://oar.sh/assets/shots/pingcf-thoughts.png?v=0.9.3" alt="An expanded Thoughts block showing the agent's reasoning above its reply"></a>
<br><sub>Read the reasoning, not just the answer.</sub>
</td>
</tr>
</table>

<a id="quick-start"></a>

## Install

### Prerequisites

You need Node.js plus whatever the runtimes you actually use need. Nothing else is required.

| Requirement | Needed for | Notes |
| ----------- | ---------- | ----- |
| Node.js 22.13 or newer | always | Both installers check this. Running the development test suite needs Node 24 (see [DEVELOPING.md](DEVELOPING.md#node-version)) |
| GitHub Copilot CLI (`copilot`), signed in | Copilot and OpenAI (BYOK) chats | Install it with `npm install -g @github/copilot`, then run `copilot` once on the relay host and sign in. The relay looks for the CLI's runtime when it starts, so restart the relay after installing or upgrading the CLI. Needs a GitHub Copilot plan that includes Copilot CLI |
| GitHub CLI (`gh`), signed in | the `oar` launcher command; Extension-engine sessions on Windows; the Copilot card in **Check Usage** | `gh copilot` is built into current GitHub CLI releases, so there is no extension to install. The usage card also accepts a token in `GH_TOKEN` or `GITHUB_TOKEN` |
| OpenAI API key | OpenAI and OpenAI Image chats | Entered in **⚙️ Settings**, stored in the relay database |
| A Claude login on the relay host | Claude chats | Log in from **⚙️ Settings → Providers → Claude → Relogin** (the panel can install the Claude Code CLI first), or run `claude` once on the host. The relay stores no Claude key |
| The same Claude login, from a claude.ai account with GitHub connected | Claude Cloud chats | The Claude GitHub app must be allowed on each repository a cloud chat works on (see [Claude Cloud](#claude-cloud)) |
| Cursor API key | Cursor chats | Entered in **⚙️ Settings**, stored in the relay database |
| Grok CLI, signed in | Grok chats | Install it and sign in from **⚙️ Settings → Providers → Grok**, or set `XAI_API_KEY` in the relay's environment |
| tmux (optional) | Linux and macOS | Session workers run in detached tmux sessions you can watch from the browser (**🖥️ Inspect tmux console**). Without tmux they run as plain background processes |

### macOS and Linux

```bash
curl -fsSL oar.sh/install | sh
```

The script checks for Node.js 22.13 or newer, runs `npm install -g @oar-sh/oar`, and then hands off to `oar setup` (with `--defaults` when there is no terminal to ask questions in). It refuses to run as root, because OAR installs per user. `OAR_VERSION=x.y.z` pins a version, `OAR_CHANNEL=beta` follows the beta channel, and `OAR_DRY_RUN=1` only prints what it would do:

```bash
curl -fsSL oar.sh/install | OAR_VERSION=0.9.6 sh
```

Read it before you run it: [oar.sh/install](https://oar.sh/install).

### Windows

```powershell
irm oar.sh/install.ps1 | iex
```

The PowerShell installer (PowerShell 5 or newer) does the same: it checks Node.js, runs `npm install -g @oar-sh/oar`, then `oar setup`. It reads the same `OAR_VERSION`, `OAR_CHANNEL`, and `OAR_DRY_RUN` variables, for example `$env:OAR_VERSION = '0.9.6'` before the command.

### npm

```bash
npm install -g @oar-sh/oar
oar setup
```

### From a git checkout

```bash
git clone https://github.com/oar-sh/oar
cd oar
npm install
node bin/oar.js setup   # writes server/config.json with a fresh auth token
npm start               # the same as: node server/server.js
```

A checkout keeps all of its state inside the repository (`server/config.json`, `server/data/`, `server/uploads/`, `server/logs/`) and never updates itself. `node server/server.js --port <port> --token <token>` overrides the config for one run without saving it.

You can also write `server/config.json` by hand; every key you leave out takes its default (see the [configuration reference](#configuration-reference-serverconfigjson)):

```json
{
  "authToken": "change-me-to-a-long-random-secret",
  "port": 3333,
  "localhostOnly": true
}
```

Development workflows, tests, and relay internals are in [DEVELOPING.md](DEVELOPING.md).

### Start the relay

`oar setup` creates the config and prints the relay URL with a QR code, but it does not start the relay. Pick one:

- **Linux (global install):** accept the systemd user service that `oar setup` offers, then run `systemctl --user enable --now oar`. The relay then starts when you log in; run `loginctl enable-linger "$USER"` once if it should keep running while you are logged out.
- **Windows:** start the relay once with `oar`, then choose **⚙️ Settings → General → Autostart (Windows)**: *At sign-in* opens a visible terminal after you log on, and *At system startup* runs it headless before anyone signs in, after one admin confirmation on the PC itself.
- **Any platform:** `oar` starts the relay in the background if it is not already running, then opens the Copilot CLI (`gh copilot`) in the same shell. A relay that `oar` started stops again when that Copilot session ends, and `oar` needs the GitHub CLI.

To run only the relay from a global install, without a Copilot session, start the server the way the systemd unit does:

```bash
COPILOT_WEB_RELAY_CONFIG="$HOME/.oar/config.json" \
COPILOT_WEB_RELAY_DATA_DIR="$HOME/.oar/data" \
COPILOT_WEB_RELAY_LOG_DIR="$HOME/.oar/logs" \
node "$(npm root -g)/@oar-sh/oar/server/server.js"
```

On Windows, point the same three variables at `%APPDATA%\oar\config.json`, `%APPDATA%\oar\data`, and `%APPDATA%\oar\logs`. The directory you start it from becomes the default working directory for new sessions.

Then open the URL that `oar setup` printed, or scan its QR code. With `localhostOnly` on (the default) that is `http://localhost:3333/` on the relay host; reach it from other devices through a [tunnel](#remote-access), or set `localhostOnly` to `false` in the config file and restart the relay for LAN access. The URL carries your token once (`?token=…`); after that, the relay keeps the browser signed in with an HttpOnly cookie.

### The `oar` command

| Command | What it does |
| ------- | ------------ |
| `oar` | Starts the relay in the background unless one is already running, then runs `gh copilot` in the same shell. The relay's output goes to its log directory, not your terminal |
| `oar -- <args>` | The same, passing `<args>` through to the Copilot CLI (`gh copilot -- <args>`) |
| `oar --port <port>` | Finds or starts the relay on `<port>` for this run, overriding the config's `port` without changing the file; a config this command creates saves it. Without it, `oar` uses the config's `port` (default `3333`) |
| `oar --migrate-from <dir>` | Global installs: copies the relay state of a pre-rename git checkout at `<dir>` into the OAR state root, once. The source is never moved or changed, and a relay still running from it blocks the copy. `oar setup` accepts the same option |
| `oar --install-extension` | Writes or refreshes the user-global Copilot CLI extension wrapper in `~/.copilot/extensions/web-relay/`, then exits. Plain `oar` does this on every run; `--no-install-extension` skips it |
| `oar setup [--defaults]` | Creates or updates the config: generates an auth token (with a config already present it offers a new one, which signs every device out), asks whether a new config should allow LAN access and whether to enable the managed Cloudflare tunnel, offers the systemd user service on Linux global installs, then prints the relay URL and a QR code. An existing config keeps its `localhostOnly` value. `--defaults` accepts every default without asking |
| `oar doctor` | Prints the version, Node.js, install mode, state root, config path, port, whether an auth token is set, the tunnel mode, the database path and size, and which provider CLIs (`gh`, `claude`, `grok`) answer. It changes nothing |
| `oar update [--beta] [--to X.Y.Z]` | Global installs: looks up the newest release of your channel in `https://oar.sh/latest.json` (`--beta` for the beta channel), installs it with `npm install -g`, and asks a running relay to restart once no turn is running. `--to X.Y.Z` installs that version straight from npm, which works even when `OAR_NO_UPDATE_CHECK=1` blocks the lookup |
| `oar --version`, `oar --help` | Prints the version, or the usage |

### Where OAR keeps its files

A global install keeps its state in `~/.oar` (`%APPDATA%\oar` on Windows; `OAR_STATE_ROOT` moves it): `config.json`, `data/` (the database and uploads), and `logs/` (`server.log` when `oar` started the relay, and a `worker-<session>.log` per Node session worker). `npm install -g` updates never touch it. A git checkout uses `server/config.json`, `server/data/`, `server/uploads/`, and `server/logs/` instead.

`COPILOT_WEB_RELAY_CONFIG`, `COPILOT_WEB_RELAY_DATA_DIR`, and `COPILOT_WEB_RELAY_LOG_DIR` override the config file, the data directory, and the log directory. `oar doctor` prints the paths in use.

### Updating

- **Global install:** **⚙️ Settings → General → Check for updates** shows a newer release with an **Update** button, which installs it with npm and restarts the relay once no turn is running. `oar update` does the same from a terminal. Automatic checks are opt-in: **Check for updates automatically** asks oar.sh about twice a day. `OAR_NO_UPDATE_CHECK=1` in the relay's environment blocks every check, manual ones included.
- **Git checkout:** `git pull`, `npm install`, then restart the relay (**🌄 Restart web relay** in the conversation's `⋯` menu).

<a id="providers"></a>

## Runtimes

The runtime (called the *provider* in the UI) is chosen in **New Chat** and then fixed for that conversation: once a conversation has sent its first message it keeps that provider, and its composer is locked to that provider's models. The composer states this above the input — `🔒 Session locked to GitHub Copilot / OpenAI / OpenAI Image / Claude SDK / ☁ Claude Cloud / Cursor SDK / Grok models.`, colour-coded per provider. OpenAI sessions also pin one exact model, which the note names in parentheses and the model dropdown shows as a disabled `🔒` entry.

Turning a provider **off** (or removing the OpenAI key) rebinds conversations that have not sent a message yet back to Copilot, so you are never left with a conversation pointing at a runtime that can no longer start. Conversations already in flight, and conversations belonging to a different provider, are left alone. Claude Cloud is the exception: switching it off only takes it out of **New Chat**, and its conversations stay as they are.

| Runtime | Enable via | Auth | Notes |
| ------- | ---------- | ---- | ----- |
| **Copilot** (default) | always available | the relay host's Copilot CLI login | Two engines: the headless **SDK** worker (default) or the Copilot CLI with OAR's **Extension**. The only runtime that reports Copilot usage |
| **OpenAI (BYOK)** | ⚙️ Settings → Providers → OpenAI | your API key, stored in the relay database | Runs the Copilot runtime, on either engine, against an OpenAI-compatible endpoint |
| **OpenAI Image (BYOK)** | ⚙️ Settings → Providers → OpenAI | the same key | The relay calls the OpenAI Images API itself; a chat whose replies are images |
| **Claude (Agent SDK)** | ⚙️ Settings → Providers → Claude | the relay host's Claude login, **switchable from the panel** | A dedicated Node worker per conversation. The Claude Code CLI can be installed and updated from the panel |
| **Claude Cloud** | ⚙️ Settings → Providers → Claude Cloud (off by default) | the relay host's Claude login (a claude.ai account), read from the Claude CLI | Claude Code in a sandbox at Anthropic, on a clone of a GitHub repository. Results come back as pushed branches; billed to that Claude account. Uses API endpoints that are not a documented public API (see [Claude Cloud](#claude-cloud)) |
| **Cursor (Agent SDK)** | ⚙️ Settings → Providers → Cursor | your Cursor API key, stored in the relay database | A dedicated Node worker per conversation through the Cursor Agent SDK |
| **Grok (CLI ACP)** | ⚙️ Settings → Providers → Grok | the relay host's Grok CLI login, **sign in and out from the panel** | Drives the Grok CLI's `grok agent stdio` over ACP. The CLI can be installed and updated from the panel |

### GitHub Copilot — engine choice

Copilot conversations, and OpenAI (BYOK) ones, run on one of two engines, chosen in **⚙️ Settings → Providers → Copilot → Copilot engine**. The setting is per relay and is read whenever a conversation's worker starts; sessions already running keep their engine until their worker restarts.

| Engine | What runs | Notes |
| ------ | --------- | ----- |
| **SDK** (default) | A headless Node worker per conversation, driving the Copilot CLI's bundled SDK runtime | Needs only a Copilot CLI that is installed and signed in; there is no extension to install or keep in sync. This engine has [mid-turn steering](#while-a-turn-runs), the [background task panel](#background-tasks) with a working **Stop**, **Cancel** on a steered message the runtime has not picked up yet, and multi-select question cards, for every Copilot model, hosted or BYOK. There is no TUI: the tmux console shows the worker's log |
| **Extension** | The Copilot CLI in a terminal session with OAR's web-relay extension loaded | The engine OAR started with. **🖥️ Inspect tmux console** shows the live Copilot TUI (Linux and macOS, with tmux). Messages sent during a turn queue behind it |

The SDK engine has been the default since 0.9.2. A relay where nobody has saved a choice uses it whenever it can and falls back to **Extension** when it cannot; a saved choice always wins. Saving **SDK** is refused, with the reason shown in place of the engine description, when:

- *"The Copilot SDK was not found when the relay started (COPILOT_SDK_PATH did not resolve)…"*: the relay found no Copilot CLI runtime at startup. It looks in the Copilot CLI's package cache, newest version first (`~/.cache/copilot/pkg` on Linux, `~/Library/Application Support/copilot/pkg` on macOS, `%LOCALAPPDATA%\copilot\pkg` on Windows; `COPILOT_PKG_DIR` adds a location), unless `COPILOT_SDK_PATH` names the runtime's `copilot-sdk` directory directly. Install or upgrade the Copilot CLI, run it once, **and restart the relay**: the launch environment is snapshotted at startup, so a CLI installed since then is not visible yet.
- *"The SDK engine requires session worker routing, which is disabled on this relay (SESSION_WORKER_ROUTING_ENABLED)…"*: with routing off no SDK worker is ever spawned. Turn **Session worker routing** back on in **⚙️ Settings → Features** (it is on by default) and restart the relay.

A refusal never changes the stored engine; the select snaps back to the engine the relay actually runs.

SDK-engine turns report their own per-turn billing to the relay, which appears as the **Last SDK worker turn** section on the Copilot card in **Check Usage**. The card's meters come from the account-level quota API and are correct for both engines.

### OpenAI (BYOK) and OpenAI Image

Save your key in **⚙️ Settings → Providers → OpenAI**, together with the **OpenAI model ID** (default `gpt-4o`) and an optional **Base URL** (default `https://api.openai.com/v1`). **Enable OpenAI API key for New Chat model selection** is on once a key is saved, and saving discovers the endpoint's models from `/v1/models`.

- **OpenAI (BYOK)** conversations run the Copilot runtime against that endpoint with your key, on whichever Copilot engine is selected.
- **OpenAI Image (BYOK)** conversations are chats whose replies are images. **New Chat** asks for **Quality** and **Size** instead of reasoning effort, and **Edit this image** under a generated image iterates on it.

### Claude (Agent SDK)

Turn on **⚙️ Settings → Providers → Claude → Enable Claude for New Chat model selection**. The relay authenticates through the Claude credentials on the host machine (`~/.claude`), so there is no key to enter.

**Commit attribution.** Commits an agent makes in a Claude session end with `Co-authored-by: Open Agent Relay (<model>) <no-reply@oar.sh>` — the model's name in the parentheses, e.g. `Claude Fable 5.1` — and pull request bodies with `🤖 Generated with [Open Agent Relay](https://oar.sh)`. The same tab has the choice: **OAR** (default), **vanilla** (Claude Code's own `Co-Authored-By: Claude …` lines) or **off** (no attribution). A repo folder can override it for all of its Claude sessions from the **🧠** context modal. A change reaches a running session with its next message (a switch back to vanilla restarts the session's CLI between turns). [Claude Cloud](#claude-cloud) chats follow the same setting. Other providers are not affected: their tools have no such setting.

The same panel manages the account itself. The row at the top names the signed-in account and plan, and:

- **Relogin** runs the Claude CLI's login on the relay host and brings the flow to the browser: the authorize link appears inline with a **Copy link** button — open it on any device, authorize on claude.ai, then paste the returned code back into the field. The relay holds no Claude secret; the CLI rewrites the host credentials, and a fresh model discovery runs straight after, so switching accounts needs no relay restart. The flow is pushed over the socket, so you can start it on one device and finish it on another, and closing the modal does not lose it.
- **Logout** asks for confirmation first and tells you how many Claude workers are running. Running Claude sessions keep the previous account's token until their worker exits; new sessions use the new account.

If Claude has never been logged in on the host, running `claude` there once works too.

Enabling Claude also runs model discovery against the Agent SDK and adds the discovered `claude-*` model IDs to the pickers (default model `claude-sonnet-5`). Use **🤗 Select Models → Claude SDK** to choose which of them appear in the composer; the configured default model always stays enabled. Discovery runs the Claude Code build bundled with the Agent SDK, so `claude update` alone never surfaces a new Claude model: that arrives with an OAR update.

What Claude conversations support:

- Per-message model and reasoning effort (`none`, `low`, `medium`, `high`, `xhigh`, `max`), changeable between turns, plus **Ultracode** on models that support `xhigh` — `xhigh` effort *and* multi-agent workflow orchestration, at a matching jump in token use
- All four relay modes — `plan` maps to the SDK's plan permission mode and produces a **Plan ready** board, `ask` and `autopilot` adjust the system prompt
- Image and file attachments (images up to 5 MB are inlined; larger files are passed as paths for Claude to read)
- Question cards (including multi-select), thinking/thought streams, live reply streaming, and nested subagent bubbles
- **Mid-turn steering** with **Steer** / **Queue**, **Stop** on the reply bubble, and **Resend** for steered messages a Stop cut off (see [While a turn runs](#while-a-turn-runs))
- Background tasks that outlive the reply that started them, in the composer's task panel, including **Ultracode** workflow trees (see [Background tasks](#background-tasks))
- Session continuity across worker restarts — the native Agent SDK session id is stored and resumed
- Real context-window metrics, reported after each turn, and a per-conversation auto-compact window (see [Usage and context](#usage-and-context))

Differences from Copilot conversations:

- Cancelling one individual subagent works only for backgrounded ones; a subagent running inside the current turn can be stopped only by stopping the whole turn
- Claude turns are not included in the Copilot usage line, and no usage line is attached to their replies (Claude's own plan limits appear in **Check Usage**)
- The browsable **Session** root points at the Agent SDK's project directory rather than a Copilot session-state folder

### Claude Cloud

**Experimental**, and off by default.

A Claude Cloud chat runs Claude Code in a sandbox at Anthropic instead of on the relay host. The sandbox works on its own clone of a GitHub repository: it sees what is pushed to GitHub and nothing on the host, and its results come back as branches the agent pushes. The chat is billed to the Claude account the relay host's Claude CLI is logged in to. In OAR it is a conversation like the others: the reply streams in, questions arrive as cards, and it works from the phone.

**What it needs.**

- The Claude CLI on the relay host, logged in with a claude.ai account (**⚙️ Settings → Providers → Claude → Relogin**, or `claude` on the host). The same login serves Claude chats.
- GitHub connected to that Claude account: [claude.ai/connect-github](https://claude.ai/connect-github).
- The Claude GitHub app allowed on every repository a cloud chat should work on (GitHub → Settings → Applications → Claude → Configure).

**Enabling.** Turn on **⚙️ Settings → Providers → Claude Cloud → Enable Claude Cloud for New Chat**. It is off by default, and it is refused while the host has no Claude login. The tab then shows:

- the account the chats are billed to, and where the relay reads the login from and until when it is valid. The login itself is changed on the Claude tab (**Claude login** jumps there);
- **Cloud environment**: the environments of the account. With none saved, the relay takes the first active one and saves it. An account without any gets its default one when you open [claude.ai/code](https://claude.ai/code) once;
- **Default model** for new cloud chats (`claude-sonnet-5-5` until you change it). The list is the Claude provider's models without their `[1m]` variants, plus the default.

Switching Claude Cloud off takes it out of **New Chat**. Cloud conversations that already exist keep working.

**Starting a chat.** Choose **+ New Chat → Provider → Claude Cloud**. The folder picker stays, but here it only fills in two fields, which you can also pick from a list or type yourself:

- **Repository**: read from the folder's `origin` remote (or the remote of its upstream branch). With the field focused, OAR lists the repositories the Claude GitHub app can reach for the account (read from Anthropic, kept for a minute; **↻** next to the label reads it again), the ones used in earlier cloud chats on this relay first and marked "used here"; typing filters the list by `owner/name`, arrow keys and Enter pick, Escape closes. `owner/repo` or a GitHub URL, https or ssh, can still be typed or pasted; only GitHub repositories are accepted.
- **Branch**: the folder's current branch; a repository picked from the list brings its default branch. With the field focused, OAR offers the repository's branches as the relay host's git sees them (`git ls-remote`, with the host's own GitHub login; the host's `OAR_CLAUDE_CLOUD_BRANCH_LOOKUP=off` turns this off). When the host cannot read them the field is a plain text field. Leave it empty for the repository's default branch.

Under the fields OAR warns about what the cloud clone will not have: commits that are not pushed, a branch without an upstream, uncommitted changes. It also says when the folder is no git repository or has no GitHub remote, when the Claude GitHub app has no access to the repository in the field (the cloud would refuse the first message), and when no cloud environment is set. There is no reasoning effort to choose. The cloud session itself is created by the first message.

**What works.**

- The reply streams in as the agent writes it, with thoughts, tool activity, subagent bubbles and the steps of the sandbox starting up
- Questions from the agent (`AskUserQuestion`) as question cards, multi-select included; a tool that asks for permission gets an **Allow** / **Deny** card. A card answered on claude.ai closes in OAR
- **Stop** interrupts the cloud turn. If the cloud does not confirm within 30 seconds, the turn ends in OAR with a note that the agent may still be working there
- Image attachments (JPEG, PNG, GIF or WebP, up to 5 MB each), sent inline
- Follow-up messages go into the same cloud session, also after it has been idle for a long time
- A restart of the worker or the relay in the middle of a turn does not send your message twice: the new worker finds the turn in the session's event log and follows it, and a turn that finished in the meantime is answered from the log. A dropped connection to the session is reopened where it broke off
- The **cloud line** above the composer: the repository, the branch, a link to the session on claude.ai, one **⇡ branch** link per branch the agent pushed (it opens GitHub's comparison with the branch the chat started from) and what the session has cost so far. The `⋯` menu has **☁️ Open on claude.ai**
- [Commit attribution](#claude-agent-sdk): commits and pull requests the agent makes in the sandbox end with what the Claude tab's setting says (**OAR**, **vanilla** or **off**), from the first message on, and a change reaches the sandbox with the next message. In OAR mode the `Claude-Session` link to claude.ai is left out too. A chat started from a folder follows that folder's override, and its **🧠** modal has the select. The commit's author is still the sandbox's git identity (`Claude`); the setting covers the lines at the end
- A turn the session starts by itself — the agent's closing turn when its background work outlived the hold, or a message you sent on claude.ai — appears in the chat as a continuation reply, with a line saying where it came from; the worker keeps the session's event stream open for that
- A turn the cloud refuses at the Claude usage limit is paused like a local Claude turn (a note with the reset time, the banner, and the work carries on by itself after the reset); the limit warning before it appears in the tool activity
- Deleting or archiving the conversation archives the cloud session at Anthropic; nothing is deleted there
- A **Claude Cloud** card in **Check Usage** with the account's cloud credit and the cost Anthropic reports for this relay's cloud sessions, and the **🧠** button for the session's context use (see [Usage and context](#usage-and-context))
- A failure the relay can name says what to do: log in again, connect GitHub, give the Claude GitHub app access to the repository, choose an environment

**What does not.**

- No relay modes, no reasoning effort and no context size: the three selectors are hidden. The model is chosen in **New Chat** and can be changed between turns in the composer like a local Claude chat's (the sandbox switches before the next message)
- No mid-turn steering: a message sent during a turn waits for the turn to end
- Nothing from the relay host reaches the sandbox: attachments other than images are refused, there is no working directory to change and no **Session** folder to browse
- No relay tools inside the sandbox: no `preview`, no `remote_relay`, no media embedded by host path
- No background task panel

**Started by an agent.** An agent in another session can start a cloud chat with the `remote_relay` tool, naming the repository and, if it wants one, the branch (`repo` and `branch`): an agent on a [paired relay](#remote-relays), under the rules for starting any session from there, or an agent on this relay once [agent sessions](#agent-sessions) are switched on. The same checks apply as in **New Chat** (the provider is on, an environment is set, the repository is on GitHub), and a chat without a requested model starts with the tab's default model. It can also read, prompt, wait for and stop a cloud chat you created.

**What OAR does with the Claude login.** Claude Cloud uses the login the Claude CLI keeps on the relay host (`.credentials.json` in `~/.claude`, or in `CLAUDE_CONFIG_DIR`) to call the Anthropic API endpoints the Claude CLI itself uses for cloud sessions and account usage. **These endpoints are not a documented public API.** Anthropic can change them without notice; cloud chats and the live usage figures then fail with a note until OAR is updated. If you are not comfortable with a program other than the CLI using its login this way, leave the provider off.

- The relay and its cloud workers only **read** the access token. It is sent as the bearer token to `https://api.anthropic.com` and to no other host. (OAR's own tests point the client at a fake API on the same machine; that setting accepts a loopback address and nothing else.)
- It is held in memory only. It is never written to the database or to a log, never sent to the browser and never put into an error message. Each cloud worker reads the credentials file itself, so nothing is passed along at launch.
- It is never refreshed by OAR, and the refresh token is never used. The CLI keeps its own login fresh; when the token has run out, the relay — and a cloud chat's worker, through the relay — reads the file again and at most once in five minutes has the CLI check its own login (`claude auth status`, which refreshes a login whose refresh token is still good), then retries. A login that is still expired ends the turn with a note to log in again.
- While the switch is off, the relay asks Anthropic for nothing with this login: it lists no environments and reads no account usage. Only a cloud conversation from before still talks to its session, when you write to it, delete it or archive it.
- The provider is off by default. Switching it on is the consent for all of the above.

`CLAUDE_CODE_OAUTH_TOKEN` in the relay's environment is used instead of the credentials file when it is set. That is the one case in which the relay passes the login on: a cloud worker started under tmux gets the variable through a file only the relay's user can read, which the worker's shell reads once and deletes; workers of other providers are not given it that way (see [Environment variables](#environment-variables)).

### Cursor (Agent SDK)

Turn on **⚙️ Settings → Providers → Cursor**, paste your Cursor API key, and enable it for New Chat model selection. Saving the key runs model discovery and also discovers each model's supported reasoning-effort tiers; use **🤗 Select Models → Cursor SDK** to choose which models appear in the composer (the configured default model, `composer-2.5` unless you change it, always stays enabled).

What Cursor conversations support:

- Per-message model and reasoning effort — effort tiers come from per-model discovery, and `none` means the model's default behavior
- All four relay modes — `plan` uses the SDK's native plan mode and produces a **Plan ready** board; `ask` and `autopilot` ride as instructions on the message text, injected only when the mode changes
- Live reply streaming, question cards, and **Stop** to abort the running turn
- The browsable **Session** root points at the worker's per-session agent store, created on the session's first turn
- Expired cached agent handles are recreated and retried automatically once — a second auth failure means the API key itself is invalid

Like Claude, Cursor turns are not included in the Copilot usage line and no usage line is attached to their replies. Cursor spend is tracked separately in **Check Usage**; set your monthly pool allowances and billing reset day under **⚙️ Settings → Providers → Cursor → Cursor monthly plan allowance**. The optional **Dashboard session token** in the same panel unlocks live *Included in plan* bars; it is detected automatically from the host's Cursor IDE login when there is one, and headless hosts can set `CURSOR_SESSION_TOKEN` instead.

### Grok (CLI ACP)

Turn on **⚙️ Settings → Providers → Grok**. There is no key to enter: the relay drives the Grok CLI on the host and uses whatever account that CLI is signed in to (or `XAI_API_KEY` in the host environment).

The same panel manages both the CLI and the account:

- The **Grok CLI** row installs or updates the CLI itself — see
  [Installing a provider CLI from the relay](#installing-a-provider-cli-from-the-relay).
- **Sign in** starts the CLI's device-code login on the relay host and brings it to the browser: the
  x.ai authorization link appears inline with a **Copy link** button, and the `XXXX-XXXX` code is
  shown next to it so you can check it against what the browser displays. Open the link on any
  device, confirm, and the panel flips to signed-in **by itself** — nothing is pasted back through
  the relay, because the CLI polls x.ai and finishes on its own. Model discovery re-runs straight
  after, so switching accounts needs no relay restart. The flow is pushed over the socket: start it
  on one device, finish it on another, and closing the modal does not lose it.
- **Sign out** asks for confirmation first and tells you how many Grok workers are running. Running
  sessions keep the previous token until their worker exits.

The relay holds no Grok secret: the device code is public by design, and the token is written by the
CLI straight into `~/.grok/auth.json`. Running `grok login` on the host still works as before.

Grok conversations support live reply streaming, thoughts, plan boards, subagent lifecycle chips,
**Stop**, session resume across worker restarts, per-turn context metrics, and the live weekly quota
bar in **Check Usage**. The model is fixed per conversation (ACP has no mid-session switch; the default
is `grok-4.5`), and question cards are not available — the protocol has no ask-user surface.

### Installing a provider CLI from the relay

Grok and Claude both run as CLIs on the relay host, and the failure mode used to be a dead end: a
turn fails with *"Grok CLI was not found on PATH"* and the only fix is a shell on the host — the one
thing the relay exists to avoid. The Copilot, Claude, and Grok sub-tabs therefore carry a CLI row at the top:

```
Grok CLI    not installed                                    [ Install ]
Grok CLI    1.0.13 · ~/.grok/bin/grok · native · up to date  [ Update  ]
```

- **Install** asks for confirmation first, naming the exact command and the directory it writes into.
  The commands are the vendors' own one-liners (`curl -fsSL https://x.ai/cli/install.sh | bash`,
  `curl -fsSL https://claude.ai/install.sh | bash`, or their PowerShell equivalents on Windows) and
  they are hardcoded in the relay — nothing you type reaches a shell. They run as the relay user,
  into your home directory, never under sudo.
- The output streams into the panel live, and the log survives closing the modal or watching from
  another device. One install at a time, relay-wide.
- When it finishes, the relay resolves the binary, wires it into the environment it launches workers
  with, and remembers it across restarts — **no relay restart is needed**. Sessions already running
  keep the binary they started with.
- **Update** runs the CLI's own updater (`grok update`, `claude update`), not the install script again.
- If your Claude was installed with npm into a folder the relay user cannot write, `claude doctor`
  says so and the button becomes **Switch to native installer** — Anthropic's own recommended fix.
  The npm copy stays where it is; the native build takes precedence on PATH.
- The **Copilot** row is read-only: that CLI is managed with npm on the host, so there is nothing
  the relay could usefully run.

When a turn fails because a CLI is missing or signed out, the failed reply itself carries the fix as
a button — **Install Grok CLI**, **Sign in to Grok**, **Claude settings** — which opens the right
panel and, for an install, the same confirmation sheet.

### Models

The composer's model picker is the union of every enabled provider's catalog, filtered to the models the active conversation's provider can actually serve:

- **Copilot** models are discovered from the installed Copilot CLI runtime a few seconds after the relay starts, and refreshed by the sessions that run on it. Each model shows the reasoning efforts and context window the runtime reports. The list starts with `auto`, then groups models by vendor (OpenAI, Anthropic, Google, xAI, Microsoft, Azure OpenAI, Moonshot AI, then any others alphabetically), newest version first. Before the first discovery, a fresh relay offers a curated set: `gpt-5.4`, `gpt-5.4-mini` (the default), `gpt-5.3-codex`, `claude-sonnet-4.6`, and `claude-haiku-4.5`.
- **OpenAI (BYOK)** models are discovered from `/v1/models` when the key is saved or re-enabled.
- **Claude** models are discovered from the Agent SDK when the provider is enabled. Bracketed `[1m]` long-context variants (such as `claude-opus-5[1m]`) do not appear as separate entries; they surface as a 1M option in the composer's context-size dropdown for the base model.
- **Claude Cloud** has no discovery of its own: its picker offers the Claude provider's models under their plain ids, plus the tab's default model.
- **Cursor** models (and their per-model reasoning-effort tiers) are discovered when the API key is saved or the provider is re-enabled.
- **Grok** models are discovered from the Grok CLI over ACP when the provider is enabled, after a sign-in, and after a CLI install from the panel.

Use **🤗 Select Models** to choose which variants show up in the composer, then **💾 Save enabled models**; **Refresh** reruns discovery for every enabled runtime. The modal has one tab per runtime — **Copilot**, **OpenAI**, **Claude SDK**, **Cursor SDK**, **Grok** — and each tab lists only the models that runtime serves; there is no cross-runtime switching inside a conversation. Claude Cloud has no tab there.

## Highlights

### New in 0.9.7

- **Claude Cloud (experimental, off by default)**: a chat that runs Claude Code in a sandbox at Anthropic, on its own clone of a GitHub repository. Pick the repository and branch from a list, follow the turn live, answer its questions, stop it, change the model between turns; the results come back as pushed branches. See [Claude Cloud](#claude-cloud) for what it needs and what it does with the Claude login.
- **Archive, and a menu on every conversation**: archive a conversation instead of deleting it (🗄 shows the archived ones), and right-click a row, or long-press it on a phone, to open, rename, stop, kill, archive or delete it.
- **Agent sessions**: an agent can start other sessions on the relay it runs on, wait for them and read their results, once you switch it on under Settings → Relays.
- **Commits say Open Agent Relay**: commits and pull requests of Claude sessions carry `Co-authored-by: Open Agent Relay (<model>)`; choose OAR, Claude Code's own lines or none, per relay and per folder.
- **Check Usage opens at once**: the last reading shows immediately and only the open tab is read live.
- **Fixes**: two prices in one paragraph are no longer shown as a formula, a reply that names an error code is no longer stored as a failed turn, and on Windows the relay no longer stalls or fails to start workers while it reads the process list.

### New in 0.9.6

- **Claude pauses at the usage limit**: a turn that runs into the subscription's usage limit is paused instead of failed. A banner above the composer says when it carries on, with **Resume now** and **Cancel**; after the reset the relay sends a message of its own that quotes what was refused. The pause survives a relay restart, and a reset more than six hours away waits for you. A second banner warns when the usage passes 90 % of a limit.
- **A quiet command no longer fails its turn** (Copilot, Cursor, Grok): how long a turn may stay silent depends on what the agent is doing: 2 minutes with nothing in flight, 5 minutes during a model request, 30 minutes while a tool runs.
- **Copilot turns that fail, fail well**: the failure shows at once, what the agent had written stays above the note, Stop works on a stuck turn, a finished reply survives a relay restart, and the commands of a runtime that died are stopped. A message you send while a command runs waits for the command instead of cutting it short.
- **Agents on paired relays can answer each other**: a relay you mentioned stays in reach for the whole session, and an agent that was asked from another relay can answer, ask back or report later. See [Remote relays](#remote-relays).
- **Less scrolling in a running turn**: subagents are folded to a one-line header that says what they are doing, and a plan board sits inside the reply it belongs to; its choice also sets the session's mode.
- **Failure notes that help**: no more advice to restart the relay, and a Claude account problem (billing, sign-in, access) says what to check. The relay keeps its console in `relay-console.log`.

### New in 0.9.5

- **A misplaced Claude reply no longer blocks the conversation**: when a reply is published as a *background continuation* instead of under your message, the message closes after about 45 seconds of silence with a small note naming that reply, and the next message runs normally. It used to hold every later message for up to 5 minutes.
- **Effort for remote sessions**: an agent can set the reasoning effort of a session it starts or prompts on another relay; a new session takes the calling session's effort when the model there supports it. See [Remote relays](#remote-relays).
- **Waiting on another relay is steadier**: the wait no longer stops at an interim answer while the remote agent goes on in a turn of its own, for example while its subagents work.
- **Worker logs on Windows**: session workers now write the same `worker-<session>.log` as on Linux, in the relay's log directory, while the console window keeps showing the output.

### New in 0.9.4

- **Remote relays**: pair two OAR relays in **Settings → Relays** by pasting the other relay's web address; the pairing works both ways. An agent in any session can then work on the other relay when you ask it to: list and read its sessions, prompt one, start a new one, wait for the reply, and pass a question the remote agent asks back to you. See [Remote relays](#remote-relays).
- **You decide when a relay is in reach**: a paired relay stays locked in a conversation until you mention it (`@` picks it from a list). Per relay, **Agents may** limits agents to *read only*, *read and prompt*, or *full*, and in ask and plan mode every write action asks you first. The receiving relay marks such messages with a **↗ from …** badge.
- **Every provider gets the same tools**: Grok and the Copilot extension engine now get `remote_relay` and `preview` as real tools through OAR's MCP server, instead of instruction text.
- **Follow the live reply**: three toggles in the running reply's header keep its thoughts, its answer, or its tool list pinned just above the composer as the reply grows. Scrolling the transcript by hand turns it off; typing in the composer does not.
- **Suspend host waits for the work to finish** (Windows): the relay queues the suspend and fires it after 2 minutes with no turn, background task, or GitHub Actions run active, or after a 30-second countdown when nothing was running. Every device shows a banner with what is still active and a **Cancel** button; a queued relay restart shows the same banner.
- **Stop** asks for confirmation before it cancels the running turn.
- **Fewer stuck and failed sends**: switching the Claude model mid-conversation no longer strands the next message, and the relay keeps idle connections open for 65 seconds, so a request sent after a short pause is no longer reset (behind a proxy or tunnel: an occasional 502).

### Everything else

- Remote chat UI for local coding agents, with the runtime chosen per conversation
- Per-message **mode** (`plan`, `ask`, `agent`, `autopilot`), **model**, and **reasoning effort** pickers, backed by live model discovery
- Streaming tool activity, thoughts, and live assistant reply text while a turn runs
- Nested **subagent bubbles**: each subagent gets its own live bubble with its own thoughts, activity, and streamed text, kept as collapsible sections after the turn finishes
- **Background task panel** with live per-task state, model, and token use; Claude workflow tasks fold out into a progress tree of phases and agents, and leave a *Finished background task* card in the transcript when they complete
- Question cards for clarification: one-click choices, multi-select checkmarks, free text, and multi-field structured forms validated against their JSON schema
- Mathematical and scientific notation rendering for TeX/LaTeX equations and chemical formulas, written as `$…$`, `\(…\)`, `$$…$$` or `\[…\]`. A single `$` opens a formula only when a non-space character follows it directly and the next `$` has a non-space character directly before it and no digit directly after it (a digit is allowed after something that looks like TeX, as in `$x^2$3`), so prices such as `$5 and $9` stay text
- **Context usage** modal with a per-category token breakdown of the model's context window, plus a per-conversation **auto-compact window** slider for Claude sessions
- **Transcript breaks**: day separators, a marker where a Claude session auto-compacted its context, and matching dots beside the scrollbar
- **Plan usage** modal with subscription credits, rate-limit windows, and reset countdowns for Copilot, Claude, Claude Cloud, Cursor, and Grok
- **Image conversations** (OpenAI Image): generate images in chat and iterate on a generated image with **Edit this image**
- Agents can embed **images, video, and audio** in a reply by their absolute path, on every runtime; clicking an embedded image opens the file viewer with zoom, download, and copy
- **Screenshot annotations**: mark up an uploaded screenshot with highlighter strokes before or after sending; the original upload is never modified
- **Share** a conversation by read-only link, and hide individual messages from the shared view
- Conversation history in local SQLite, including the Copilot sessions already stored on the host
- `/compact` continues in a fresh conversation seeded with a summary; `/preview` publishes a local dev server or folder on a public preview host
- Workspace and drive browser with file previews, **Git changes** with a diff viewer, and `@file:` / `@folder:` reference tokens
- **Push notifications** for questions, finished or failed turns, plan boards, and a CLI going offline
- Opt-in **self-update** from Settings or `oar update`
- Remote access through a managed **SSH** reverse tunnel or **Cloudflare Tunnel**
- Installable **PWA** with an installed-app fullscreen preference and browser-mode fallbacks

## Using the web UI

### Starting a conversation

- Start a chat with **+ New Chat**, which asks for the **Working directory**, **Provider**, **Model**, and **Reasoning effort** (or **Quality** and **Size**, for image chats; **Context window** where a model offers several) before the conversation exists. The working-directory list offers the known directories (current session, relay workspace, browser folder, recent roots), a **Custom path…** entry, and a 📁 folder picker; it defaults to the directory you picked last, and the chosen directory is applied before the session worker first launches. With Copilot as the only provider the provider row is hidden. For **Claude Cloud** the modal asks for a **Repository** and a **Branch** instead of a reasoning effort, filled in from the chosen folder (see [Claude Cloud](#claude-cloud)).
- Choose the **mode** and **model** per message in the composer.
- The composer knows two slash commands, with autocomplete: **`/compact`** branches to a fresh conversation seeded with summary context, and **`/preview`** publishes a local dev server or directory on the public preview host without involving the agent (`/preview 5173 [label]`, `/preview ./dist [label]`, `/preview list`, `/preview close`). Agents can do the same through the `preview` tool (Claude and Cursor) or the documented API (see [docs/preview-servers.md](docs/preview-servers.md)). Any other single-line text starting with `/` is held back once with an *Unknown command* notice; press send again to send it as text.

### Relay modes

| Mode        | Behavior                                                     |
| ----------- | ------------------------------------------------------------ |
| `ask`       | Clarification-first behavior before implementation           |
| `plan`      | Planning response style (no implementation unless requested) |
| `agent`     | Interactive coding agent behavior                            |
| `autopilot` | Action-first behavior; asks only when truly blocking         |

### While a turn runs

- Assistant text streams into the pending bubble as it is generated, next to the turn's tool activity and thoughts. Any subagent the turn spawns gets its own nested bubble with its own thoughts, activity, and text.
- **Steer or queue.** On Claude, and on Copilot's SDK engine, a message you send during a live turn is pushed into that turn; the send button reads **Steer**. A folded message keeps a compact *merged* marker in the transcript, and one the agent answers separately gets its own reply. While the turn waits on a question card or plan approval, or is compacting, the button reads **Queue** and its tooltip says why: the message waits as a pending bubble (with **Cancel**) and steers in once the card is answered or the compaction ends. On the other runtimes, and on Copilot's Extension engine, messages sent during a turn queue behind it, and the button reads **Queue**.
- **Stop** is on the running reply's bubble, whose header stays pinned at the top while a long reply scrolls; the send button never turns into Stop. Queued messages carry their own **Cancel** until they are picked up. A steered message that a Stop cut off is marked *Stopped with the turn — not answered* and offers **Resend**; the button then reads **Resent** on every device.
- On Copilot, **Stop** ends only the reply: background agents the turn started keep running under their own **Stop** in the task panel.

### Question cards

- Agents ask clarifying questions through question cards: `ask_user` on Copilot and Cursor, `AskUserQuestion` on Claude and Claude Cloud. A choice answers with one click; a question that allows several answers shows checkmarks and one **Reply with selection** button, whose reply lists every ticked choice plus anything you typed. Structured requests render as multi-field forms.
- On Copilot's SDK engine, the model gets OAR's own `ask_user` tool, which can mark a question as multi-select; a question worded "select all that apply" counts too, and every Copilot choice card that accepts free text has a **Select several** switch.
- A card waits 8 hours for an answer (2 hours on Copilot's Extension engine). After that the agent is told nobody answered and continues according to the conversation's mode. A turn that is waiting on a card is never treated as stuck.
- Grok has no question cards: ACP has no ask-user surface.

### Background tasks

- The composer's task panel lists background work that outlives the reply that started it: backgrounded commands, subagents, monitors, and workflows on Claude; background agents and detached shells on Copilot's SDK engine. Each row shows its state, the model it runs on, the command it is running right now, its token count, and its own **Stop**. The panel scrolls when it holds more tasks than fit.
- An **Ultracode** workflow folds out into a tree of its phases and agents (state, model, tokens). When it finishes, the summarizing reply keeps a collapsed *Finished background task* card holding the final tree, which survives reloads.
- A background task's result arrives as its own *continuation* reply.
- **⚙️ Settings → General → Background task timeout** (default 4 h; 0 = no limit, up to 10 h) caps how long background tasks alone may keep a Claude or Copilot session running after its reply. When the limit is reached, the tasks are stopped.

### Drafts across devices

The composer draft, attachments included, is saved per conversation on the relay and follows you to your other devices. Saves happen only on real edits and are version-checked, so an idle device never overwrites the draft you are typing on another one, and a device you are not typing on picks up the other's draft. When two devices edit at once, the newest keystroke wins and the replaced text is offered back with **Restore** (and **Undo**). A draft longer than 20,000 characters is saved up to that length, and the composer says the rest is not saved.

### The conversation list

- **Filter conversations…** above the list matches titles, ignoring case. It clears with **×** or Escape, and while it is active it loads older pages, so it searches every conversation, not just the loaded ones.
- **🔍** in the conversation header searches message text across all conversations.
- On startup, the relay imports the Copilot sessions stored on the host (through the installed Copilot runtime) into its database, so they appear in the list with their history. If the runtime is unavailable, the import is reported as failed rather than guessed from the filesystem.
- **Archive** (🗄 on the row, or **Archive conversation** in the `⋯` menu) takes a conversation out of the list without deleting anything: its session worker is stopped, and a Claude Cloud chat's session at Anthropic is archived with it. The 🗄 toggle above the list shows the archived conversations; **Unarchive** (📂) brings one back, cloud session included. An archived chat that is opened cannot be sent to until it is unarchived; a message that reaches it anyway (an agent's through a paired relay, say) unarchives it. A conversation that is still working is not archived — stop it first.
- A **right-click on a row** (a long press on a phone) opens a menu with Open, Edit title, Stop turn, Kill session, Archive or Unarchive, and Delete, so a session can be stopped or killed without opening it.
- Deleting a conversation stops its session worker and removes its CLI session too (Copilot through the runtime, Claude by deleting that session's transcript). A Claude Cloud conversation's session at Anthropic is archived, not deleted. An imported Copilot session the relay never ran is only hidden: its CLI session stays, and nothing is stopped for it. A conversation that is still working — a running turn, one waiting on a question card or approval, or live background tasks — is not deleted, and the sidebar says why so you can stop it first.

### Files, git, and previews

- Use **📁 Browse files** to inspect the workspace (💼), drives (📀), or the session's own folder (🕵️), and to open previews. The **Hidden** and **Heavy** toolbar filters are remembered per browser, and a refresh re-opens the folders you had expanded.
- Click the file and folder copy controls to insert `@file:...` / `@folder:...` tokens.
- Workspace browsing follows the selected session's effective working directory. Running sessions keep their learned runtime directory, **🗂️ Change CWD** in the `⋯` menu changes the directory for the next launch, and `cd ...` typed in chat does not retarget the browser. A Claude Cloud chat has no **Change CWD**: it works on a clone at Anthropic.
- Use **🌿 Git changes** in the conversation `⋯` menu to review the workspace repository: the header shows the branch with ahead/behind counts and a **⬇ Pull** button, and the list shows every staged, unstaged, and untracked file (deleted files struck through). Clicking a file opens a diff viewer with **Changes** and **Full file** modes; closing it returns to the still-open list.
- Agents can embed images, video, and audio in a reply by absolute path; they render inline.
- Tap an image attachment in the composer (it carries a 🖍️ badge), or use **🖍️ Annotate** in the file viewer, to mark it up with highlighter strokes. The annotated copy is uploaded; the original stays untouched.
- External links in chat open in a new tab with `noopener`/`noreferrer`; workspace file mentions stay in the in-app preview.

### Usage and context

- Use **📊 Check Usage** in the conversation `⋯` menu for plan usage across every configured provider: remaining credits, rate-limit windows, reset countdowns, and collapsible cost/token detail. Each provider gets its own tab, opening on the conversation's own provider, and the card names the signed-in account (email and plan) beneath its title. The modal opens on the reading it showed last time and reads only the open tab's provider live (its card says "updating…" until the answer is in); a tab you switch to is read live when its reading is older than a minute, **Refresh** reads the open tab, and the relay keeps the last live answer of every provider so the other cards are never empty. Sources differ per provider:
  - **Copilot** — live quota (AI credits or premium requests, chat, plan), plus per-model/product billed cost when your GitHub token can read personal billing. Conversations on the SDK engine add a **Last SDK worker turn** section (AI credits actually spent, tokens, model calls, overage) with the model and how long ago it was captured; it is one turn's numbers rather than a running total, and it stops being shown once it is more than seven days old.
  - **Claude** — subscription limit windows (5-hour, weekly, per-model), extra-usage credits, session cost, and local usage attribution. Read from the live session at the end of a turn; the relay never starts a hidden turn to refresh it, so the newest reading is from your last Claude turn. With **Claude Cloud** switched on, the limits are read live from the account each time the modal opens (kept for a minute), with no turn involved: the card then carries a **Live** badge, a limit that is getting close carries Anthropic's own warning word, and it adds **This week by product** (Claude Code, chats and the other products as shares of the week) and the organisation's **Prepaid credits** when there are any. Limit resets (full and 5-hour) are shown on claude.ai only; the card links there. When the live read fails, the card falls back to the last turn's reading and says why.
  - **Claude Cloud** — shown while the provider is on. A meter per dollar credit the account holds, with what is used, what is left and when it expires; **Cloud spend (OAR sessions)**, the cost Anthropic reports per cloud session, summed over the cloud conversations this relay still has, with this conversation's own cost when the modal was opened from a cloud chat; and the latest cloud session report (its cost, and cost and tokens by model). These figures are Anthropic's reported cost, not a billing statement, and sessions started elsewhere are not counted. A credit that is offered but not yet claimed is mentioned with a link to claude.ai. Cloud turns spend the cloud credit first; without a credit they count against the Claude limits above.
  - **Cursor** — spend from the Cursor SDK measured against the monthly allowances you enter in Settings, split into the Cursor Models and Other Models pools; these figures are estimates, and Cursor's Spending dashboard remains authoritative. With a dashboard session token, the card adds live *Included in plan* bars.
  - **Grok** — the live weekly subscription quota, read with the host's Grok CLI login, plus per-turn tokens and estimated cost from the agent's prompt result. An optional monthly USD allowance in Settings adds an estimated remaining meter; the card is hidden when Grok is disabled. Billing: [console.x.ai](https://console.x.ai).
- Per-reply usage lines are recorded only for Copilot turns — OpenAI, Claude, Claude Cloud, Cursor, and Grok turns do not consume Copilot premium requests, and no usage line is attached to them.
- Use the **🧠** context button for a per-category breakdown of the conversation's context window (Claude sessions also show the auto-compact window, the thinking controls and the folder's commit attribution there): a usage bar, a token/percentage table, and free space. Claude sessions report exact SDK categories; Copilot sessions show the coarser system/tools + messages + buffer split, labelled as a lower-bound estimate when the runtime no longer emits full buckets. A Claude Cloud session reports how much of its window is used after each turn, without categories.
- Claude conversations additionally get an **auto-compact window** slider in that modal. Claude Code compacts a session once it approaches a model-tuned window (around 967k tokens on a 1M-context model), which is why long conversations rarely compact at all; setting a smaller window makes it happen sooner and keeps turns cheaper. *Auto* hands the choice back to the CLI. The smallest window is 100k, because the CLI silently ignores anything below that and falls back to its own default. The line beneath the slider reports the window actually in force and where it came from — your setting, the model default, or the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment override — and fills in once the conversation's first turn completes. The change reaches a running session on its next message.
- The transcript marks day boundaries, and marks the point where a Claude session compacted its context with the tokens before and after. Both appear as dots beside the scrollbar for the messages currently loaded.

### Sharing

Use **➡️ Share conversation** in the `⋯` menu to publish a read-only link. Each message has a **Hide** button that keeps it out of the shared view without deleting it; hidden messages stay fully visible to you, marked *Hidden from shared viewers*, with an **Unhide** button. Anyone with the link can read the shared view, without signing in.

### Notifications and the app

- **⚙️ Settings → Notifications** turns on push notifications per device: for questions from the agent, completed or failed turns, plan boards, and the CLI going offline. They need a secure context (HTTPS, or `localhost`), are sent only while no device has the app in the foreground, and show generic text unless you opt in to message previews on that device.
- The **⬇** button in the sidebar installs OAR as an app (PWA). **Relay name** in Settings sets its label on every device that connects to this relay, and is the name [paired relays](#remote-relays) know it by.

### The conversation menu

Besides the entries above, the `⋯` menu holds **✍️ Edit conversation title**, **🗄 Archive conversation** (**📂 Unarchive** on an archived chat), **🖥️ Inspect tmux console** (a read-only view of the session's tmux pane), **🤗 Select Models**, **☁️ Open on claude.ai** (Claude Cloud chats, once their session exists), **⚙️ Settings**, **🌄 Restart web relay** (queued until the current turn is idle), **💤 Suspend host** (Windows; see below), and **☠️ Kill session** (stops the conversation's worker; an active turn then needs a retry or a new message). Its header shows the queue counts with **🚮 Empty queue**.

**💤 Suspend host** puts the machine the relay runs on to sleep, once the work is done. The confirmation lists what is still active. The relay then queues the suspend and fires it after 2 minutes with nothing active: no queued, running or parked turn, no background task of a live worker, and no open GitHub Actions run in the repository of a conversation that was busy since the request (read through `gh`; a repository whose state cannot be read blocks for 15 minutes, then is ignored). With nothing running when you confirm, it fires after a 30-second countdown. While a suspend is queued, every device shows a banner with the blockers or the countdown and a **Cancel** button, and a push notification reports the suspend. A relay restart drops a queued suspend and says so. **Show Suspend host action** in Settings hides the entry per browser.

## Settings and configuration reference

### Settings (⚙️ in the web UI)

The modal is organised into six tabs — **General**, **Providers** (with a **Copilot**, **OpenAI**, **Claude**, **Claude Cloud**, **Grok**, and **Cursor** sub-tab), **Relays**, **Previews**, **Notifications**, and **Features** — and reopens on the tab you used last. Unless noted as per browser, these settings live in the relay database rather than the config file, and apply to every browser that connects:

| Tab | Setting | Default | What it does |
| --- | ------- | ------- | ------------ |
| General | Theme, Text scaling | dark theme | Per browser |
| General | Show Suspend host action | on | Per browser: shows **💤 Suspend host** in the conversation menu |
| General | Max turn duration | `60 min` | Hard cap on how long one turn may run before the relay requeues it (0 = no limit, up to 10 h; see below) |
| General | Background task timeout | `4 h` | How long background tasks alone may keep a Claude or Copilot session running after its reply; then they are stopped (0 = no limit, up to 10 h) |
| General | Autostart (Windows) | Off | *At sign-in* (a visible terminal after you log on) or *At system startup* (headless, no logon needed, one admin confirmation) |
| General | Relay name | `OAR` (the hostname for paired relays) | Label of the installed PWA on every device, and this relay's name for [paired relays](#remote-relays) |
| General | Check for updates automatically | off | Opt-in: the relay asks oar.sh for the latest version about twice a day. **Check for updates** works regardless; `OAR_NO_UPDATE_CHECK=1` blocks both |
| General | Default CWD for new sessions | relay workspace root | Working directory for newly created sessions that have none of their own |
| Providers | Copilot engine | SDK | Extension when this relay cannot run the SDK engine (see [engine choice](#github-copilot--engine-choice)) |
| Providers | OpenAI API key / model / base URL | — / `gpt-4o` / `https://api.openai.com/v1` | Enables the OpenAI and OpenAI Image providers |
| Providers | Claude (Agent SDK) | off | Enables Claude as a New Chat provider and runs model discovery; default model `claude-sonnet-5` |
| Providers | Claude account (Relogin / Logout) | host login | Switches the Claude account the relay host's CLI uses, from the browser (see [Claude (Agent SDK)](#claude-agent-sdk)) |
| Providers | Claude Cloud | off | Enables Claude Cloud as a New Chat provider, and the live account figures in **Check Usage**; the switch is the consent to use the Claude CLI's login (see [Claude Cloud](#claude-cloud)) |
| Providers | Claude Cloud environment / default model | first active environment of the account / `claude-sonnet-5-5` | The cloud environment new cloud sessions run in, and the model a new cloud chat starts with |
| Providers | Cursor API key / model | — / `composer-2.5` | Enables Cursor; plus monthly plan allowances and the optional dashboard session token |
| Providers | Grok | off | Enables Grok; default model `grok-4.5`; **Sign in** / **Sign out**; optional monthly allowance |
| Relays | Public address, Accept prompts from other relays' agents | browser address / on | How paired relays reach this one, and whether their agents may prompt sessions here (see [Remote relays](#remote-relays)) |
| Relays | Agent sessions: Agents may start and use sessions on this relay | off | Lets agents on this relay start and use other sessions here with the `remote_relay` tool; the first session an agent starts in a conversation asks for your approval (see [Agent sessions](#agent-sessions)) |
| Relays | Agent sessions: Longest wait per tool call | `10 min` | How long one `remote_relay` call may wait for a reply (2 to 60 minutes), on this relay and on paired ones; adjustable whether or not the switch above is on |
| Relays | Remote relays | — | Pair a relay by pasting its web address; per relay **Agents may** read only, read and prompt, or do everything |
| Previews | Live previews | — | Lists the published previews, each of which you can close |
| Notifications | Push notifications | off | Per device: which events notify, and whether titles and message previews are included |
| Features | Feature flags | see below | **Session worker routing** (on), **Continuation answer routing** (on), **Generated-image continuity** (on), and a reserved **Worker fallback restart** (off, no effect yet). Changes apply after a relay restart; a `COPILOT_REMOTE_<FLAG>` environment variable pins a flag, e.g. `COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED=0` |

### How a stuck turn is detected

Two independent guards, both of which exempt a turn that is waiting on an unanswered question card:

1. **Inactivity** — a turn is only considered stale after `processingTimeoutMs` with no sign of life from its worker. Worker heartbeats name the message they are working on, so a turn that legitimately runs for an hour of tool calls keeps resetting this window.
2. **Max turn duration** — an absolute ceiling on elapsed time, set with the Settings slider (0 = no limit, up to 10 hours). This exists purely to catch a worker that has hung while still heartbeating.

When either trips, the turn is returned to the queue rather than lost.

### Configuration reference (`server/config.json`)

The config file is `server/config.json` in a git checkout and `~/.oar/config.json` (`%APPDATA%\oar\config.json`) for a global install; `COPILOT_WEB_RELAY_CONFIG` points the relay at another file. It holds the auth token, so the relay keeps it owner-only. The relay reads it at startup: restart the relay after editing it.

| Key                        | Default              | Description                                                               |
| -------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `authToken`                | generated if empty   | Required for API/UI auth. If empty, the relay generates a random token on every start and prints it to its log without saving it; `oar setup` writes a stable one |
| `port`                     | `3333`               | HTTP + WebSocket port                                                     |
| `localhostOnly`            | `true`               | Bind only to loopback (`127.0.0.1`) and disable LAN/WAN access            |
| `dataDir`                  | `data/` beside the server | Database and uploads; a relative path resolves against the config file's directory. `COPILOT_WEB_RELAY_DATA_DIR` wins, and global installs started by `oar` use `~/.oar/data` |
| `processingTimeoutMs`      | `600000`             | Inactivity window before a turn is treated as stale (not a cap on turn length) |
| `conversationSessionMode`  | `isolated`           | Configured strategy (`isolated` / `shared`) recorded on sessions and exposed in status |
| `maxRequeueRetries`        | `5`                  | Queue retry limit for failed processing                                   |
| `remotePath`               | `""`                 | URL base path when reverse-proxied under a subpath; also drives PWA URLs and socket.io path |
| `trustProxy`               | `"loopback"`         | Which proxies may set `X-Forwarded-*` headers (Express `trust proxy`); widen it with a hop count or subnet when a proxy on another host forwards to the relay |
| `workspaceRootAllowList`   | unset                | Directories that conversations may start in (they and their subdirectories); unset allows any. `COPILOT_WORKSPACE_ROOT_ALLOW_LIST` sets it too, separated by the platform's path delimiter |
| `publicHostnames`          | `[]`                 | Hostnames the relay itself answers on; the preview lane refuses to share one |
| `tunnelMarkerHeaders`      | `[]`                 | Extra edge-injected headers that mark tunnel traffic (see [Session-worker path guard](#session-worker-path-guard)) |
| `sshTunnel.mode`           | `disabled`           | Tunnel mode (`disabled` or `managed`)                                    |
| `sshTunnel.enabled`        | `false`              | Legacy alias (`true` => `managed`)                                       |
| `sshTunnel.required`       | `false`              | Pause dequeue while managed tunnel is disconnected                        |
| `sshTunnel.remoteBind`     | `loopback`           | Remote bind mode for SSH `-R` (`loopback` or `public`)                    |
| `sshTunnel.command`        | `ssh`                | SSH executable path/command                                               |
| `sshTunnel.user`           | —                    | SSH user                                                                  |
| `sshTunnel.host`           | —                    | SSH host                                                                  |
| `sshTunnel.remotePort`     | —                    | Remote forwarded port                                                     |
| `sshTunnel.identityFile`   | optional             | SSH key path (falls back to default agent/key)                            |
| `cloudflaredTunnel.mode`   | `disabled`           | Cloudflare tunnel mode (`disabled` or `managed`; `enabled: true` is a legacy alias for `managed`) |
| `cloudflaredTunnel.required` | `false`            | Pause dequeue while the managed Cloudflare tunnel is disconnected         |
| `cloudflaredTunnel.token`  | —                    | The tunnel token from your own Cloudflare Zero Trust tunnel               |
| `cloudflaredTunnel.binary` | *(auto)*             | `cloudflared` path; defaults to the npm package, then `PATH`              |
| `cloudflaredTunnel.extraArgs` | `[]`              | Extra arguments appended to `cloudflared tunnel run`                      |
| `previews.enabled`         | `false`              | Publish local dev servers on a separate listener (see [docs/preview-servers.md](docs/preview-servers.md)) |
| `previews.port`            | `port + 1`           | Loopback port for the preview listener; `0` picks an ephemeral port        |
| `previews.bindHost`        | `127.0.0.1`          | Bind address; non-loopback needs `previews.allowPublicBind`                |
| `previews.publicBaseUrl`   | —                    | Public base URL on a hostname **different** from the relay's               |
| `previews.allowedTargetHosts` | `[]`              | Upstreams allowed beyond loopback (container/VM IPs)                       |
| `previews.maxLive`         | `8`                  | Maximum simultaneously published previews                                  |
| `pushVapidSubject`         | `mailto:copilot-remote@example.com` | Contact URI the relay sends to push services with Web Push requests |
| `sharedPresenceMaxPerConversation` | `200`        | Most live viewers tracked per shared conversation                          |
| `sharedPresenceMaxGlobal`  | `5000`               | Most live shared-link viewers tracked in total                             |
| `cliBinaries`              | *(written by the relay)* | Provider CLI paths resolved after an install from Settings, restored at startup |
| `restartGracefulTimeoutMs` | `8000`               | Graceful restart wait before force fallback                               |
| `restartShutdownTimeoutMs` | `45000`              | Drain timeout while waiting for active queue job completion               |
| `restartSpawnTimeoutMs`    | `18000`              | Max wait for resume/restart phase per attempt                             |
| `restartRebindTimeoutMs`   | `20000`              | Max wait for rebind/session-sync completion per attempt                   |
| `restartMaxAttempts`       | `3`                  | Bounded restart attempts before terminal exhaustion                       |
| `restartRetryBackoffMs`    | `[1000,3000,7000]`   | Deterministic retry backoff schedule in milliseconds                      |

### Environment variables

| Variable | Effect |
| -------- | ------ |
| `COPILOT_WEB_RELAY_CONFIG` | Config file to use |
| `COPILOT_WEB_RELAY_DATA_DIR` | Data directory (database and uploads) |
| `COPILOT_WEB_RELAY_LOG_DIR` | Log directory |
| `OAR_STATE_ROOT` | State root of a global install, instead of `~/.oar` / `%APPDATA%\oar` |
| `OAR_NO_UPDATE_CHECK=1` | Never contact oar.sh, not even for a manual update check |
| `OAR_HOST_SUSPEND_DRY_RUN=1` | **Suspend host** logs the suspend instead of sleeping the machine |
| `OAR_MCP_SERVER=0` | Do not attach OAR's MCP server to Grok and the Copilot extension engine; they get the preview instructions as text again, and no `remote_relay` tool |
| `COPILOT_SDK_PATH` | The Copilot CLI runtime's `copilot-sdk` directory, instead of the newest one in the CLI's package cache |
| `COPILOT_PKG_DIR` | An additional Copilot CLI package cache to search |
| `GH_TOKEN`, `GITHUB_TOKEN` | GitHub token for the Copilot usage card, instead of `gh auth token` |
| `XAI_API_KEY` | Grok authentication instead of the Grok CLI login |
| `CURSOR_SESSION_TOKEN` | Cursor dashboard session token for live plan bars |
| `CLAUDE_CONFIG_DIR` | Claude configuration directory, instead of `~/.claude`; Claude Cloud reads the CLI's login (`.credentials.json`) from it |
| `CLAUDE_CODE_OAUTH_TOKEN` | A Claude login token for Claude Cloud, used instead of the CLI's credentials file, by the relay (settings tab, **Check Usage**, archiving) and by its cloud workers. Under tmux the relay hands it to cloud workers only, through an owner-only file; a worker started without tmux inherits the relay's environment as it is |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Overrides the Claude auto-compact window |
| `COPILOT_CLOUDFLARED_MODE`, `COPILOT_CLOUDFLARED_TOKEN`, `COPILOT_CLOUDFLARED_BINARY` | Override `cloudflaredTunnel.mode`, `.token`, and `.binary` |
| `COPILOT_WORKSPACE_ROOT_ALLOW_LIST` | Same as `workspaceRootAllowList` |
| `COPILOT_REMOTE_<FLAG>` | Pins a feature flag from the **Features** tab (`1`/`0`, `true`/`false`) |

Many internal names still say "copilot" (`COPILOT_WEB_RELAY_*`, `copilot.db`) from the project's earlier life; they apply to every runtime.

### API overview

Every authenticated HTTP route accepts `Authorization: Bearer <token>` or the login cookie; the routes are documented in [server/README.md](server/README.md#api-reference).

## Remote access

`localhostOnly` controls only the relay's own listener (`127.0.0.1` vs `0.0.0.0`). To reach the relay from outside your network, prefer one of the two managed tunnels below over opening a port. They are independent and can run at the same time.

### Optional remote internet access (SSH tunnel)

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

### Optional remote internet access (Cloudflare Tunnel)

An alternative to the SSH tunnel that needs no VPS and no inbound port: the relay
supervises Cloudflare's `cloudflared` binary, and Cloudflare carries your hostname down
to `127.0.0.1:3333`.

1. In your own Cloudflare Zero Trust account, create a tunnel and route a public hostname on
   your zone to `http://localhost:3333` (or your `port`). That routing lives in Cloudflare, not
   on this machine.
2. Put the tunnel's token into the config and restart the relay. (`oar setup` can switch the
   tunnel on for you; it still needs the token.)

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
The binary resolves from `cloudflaredTunnel.binary`, then the optional `cloudflared` npm
package, then `PATH`; a managed config with no resolvable binary is reported as a config
error instead of crashing. Connection drops reconnect with jittered exponential backoff,
and repeated fast exits (deleted tunnel or bad token) are reported as `auth-or-config`
instead of hammering Cloudflare.

The relay status dot turns **amber** while the Cloudflare tunnel is connected, so it is
obvious at a glance that the relay is reachable from the internet rather than only from
this machine. It stays green when no tunnel is configured and grey when the relay itself
is unreachable; a managed tunnel that has dropped keeps the dot green — the relay still
answers locally — and reports the drop in the tooltip.

### Session-worker path guard

Any public tunnel forwards *every* path on the bound hostname to port `3333`, including
the internal session-worker WebSocket endpoints. Requests to those paths that carry an
edge marker header (`cf-ray`, plus anything listed in `tunnelMarkerHeaders`) are rejected
with `403` on both the request and upgrade paths. Local workers connect over `127.0.0.1`
without such a header and are unaffected, and shared conversation links keep working
anonymously over the tunnel.

Shared links work unchanged through Cloudflare. Do not add a Cloudflare Cache Rule
covering `/api/shared/*` — shared views poll for liveness and an edge-cached response
would pin viewers to a stale snapshot. Likewise, a Cloudflare Access application over the
bound hostname breaks share links unless it bypasses `/shared/*` and `/api/shared/*`.

## Remote relays

Several OAR relays can be paired, for example the one on your workstation and the one on a
server. An agent in any session can then work on the other relay when you ask it to: list and
read its sessions, prompt one, start a new one, wait for the reply, and pass a question the
remote agent asks back to you.

**Pairing.** Open **Settings → Relays** and paste the other relay's web address (the URL you
open it with in the browser). OAR checks the address with its own token, or with a
`?token=` the pasted link carries, and asks for a token only when that fails. It reads the
other relay's name from its API. With **Also add this relay there** checked, it introduces
itself to the other relay using the address in **Public address**, so the pairing works in both
directions. When the two relays use different tokens, that introduction hands over this relay's
token, so the other relay's agents can then work here. Each side can remove the other on its own,
but removing a relay does not revoke a token it already holds: rotate the token for that. A relay
that is already paired keeps the address and token stored for it when it introduces itself again;
change those in **Settings → Relays**.

A relay's name is the **Relay name** under **General** (it also names the installed app); when it
is empty, the machine's hostname is used.

**Mention a relay to unlock it.** Agents can see which relays are paired, but a relay stays
locked in a conversation until you mention it in one of your messages: type `@` and pick it
from the list, or write its name or its host name. An IP address or `localhost` never counts as a
host name; a relay whose name is itself an address is unlocked only with a leading `@`. The
mention unlocks that relay for the rest of
the conversation, whatever prompts arrive in it later.

**Agents can answer each other.** When an agent on a paired relay writes to a conversation, that
relay is open to the conversation from then on, within what **Agents may** allows, so the agent
that was asked can answer, ask back or report later. A prompt from an agent never unlocks any
other relay. A prompt that already crossed two relays is not passed on to a third one unless you
unlocked that relay yourself; reading and waiting are never limited. When the agent of a
conversation has sent 30 prompts to agents on other relays without a message from you, the next
one asks you first with a question card; **Allow** starts the count again.

**What agents can do.** Every provider gets the same `remote_relay` tool (Claude, Cursor and
Copilot directly; Grok and the Copilot extension engine through OAR's MCP server). Sessions get it
while at least one relay is paired or [agent sessions](#agent-sessions) are switched on. Per paired
relay, **Agents may** limits it to *read only*, *read and prompt* (existing sessions) or *full*
(also create sessions, answer questions, stop turns, archive). In the *ask* and *plan* relay
modes, every write action first asks you with a question card. For a session it starts, an agent
can set the provider, model, relay mode and reasoning effort; what it leaves out follows the
session it works in, as far as the other relay offers it. A [Claude Cloud](#claude-cloud) session
is started with `provider: "claude-cloud"`, a `repo` (a GitHub URL or `owner/repo`, for example
`example-org/sample-repo`) and an optional `branch` instead of a folder; without a model it gets
the default model of the other relay's Claude Cloud tab. Claude Cloud must be switched on there.
A cloud session that exists can be read, prompted, waited for and stopped like any other.

A `send`, `create_session` or `wait` call waits for the reply for as long as the agent asks, up to
**Longest wait per tool call** of the relay the agent runs on (10 minutes unless you changed it,
see [Agent sessions](#agent-sessions)). When the time is up the agent gets what there is so far
and can call `wait` again.

When an agent prompts a session on another relay, that relay shows a **↗ from …** badge with the
sending relay, session and model on the message, and marks sessions an agent created in the
conversation list. The remote agent sees a one-line header saying that another agent is talking
to it. Turns started this way do not send "reply ready" notifications on the remote relay;
question cards still do. **Accept prompts from other relays' agents** in **Settings → Relays**
switches incoming agent prompts off.

The calls go through your own relay, which holds the other relay's token: agents never see a
token. Remote addresses must use `https://`; plain `http://` is accepted only for loopback (an
SSH port forward, for example) and private network ranges.

### Agent sessions

The same `remote_relay` tool can also work on the relay the agent itself runs on. An agent can
then hand parts of its task to other sessions: it starts them, waits for them and reads their
replies. Every session it starts is an ordinary conversation in your list. No relay has to be
paired for this.

**Switching it on.** It is off by default. Turn on **Settings → Relays → Agent sessions →
Agents may start and use sessions on this relay**. From then on this relay is the first entry of
the relay list an agent sees, marked as its own; the agent names it by its **Relay name** or as
`this`. It needs no mention, and **Agents may** and **Accept prompts from other relays' agents**
do not apply to it. On this relay an agent can do what *full* allows on a paired one: list and
read every session here, prompt one, start one, wait for it, answer its question, stop its turn
and archive it. Switching the setting off closes this relay to the tool again.

**The rules.**

- **Approval once per conversation.** The first time the agent of a conversation wants to start
  a session here, a question card (**Agent sessions**) shows the provider, the folder or
  repository and the prompt. **Allow** covers every session that conversation's agent starts
  later, also after a relay restart; **Deny** refuses that one call. In the *ask* and *plan*
  relay modes, every other write action still asks, as it does for a paired relay.
- **At most 4 at work.** Of the sessions one conversation's agent started, 4 may have a turn
  queued or running at the same time. A fifth is refused until one of them has finished.
- **One level only.** A session that an agent created, here or from a paired relay, cannot start
  sessions on this relay.
- **Not on itself.** An agent cannot prompt, stop, archive, wait for or answer the conversation
  it runs in.
- The count of 30 prompts without a message from you (see above) includes prompts to sessions
  on this relay.

**What it can start.** A session with any provider that is enabled on this relay (Copilot,
OpenAI, Claude, Cursor, Grok or Claude Cloud; not an OpenAI Image chat): in a folder
(the relay's default folder when the agent names none), or a [Claude Cloud](#claude-cloud) chat
with `provider: "claude-cloud"`, `repo` and an optional `branch`. A new session knows nothing of
the conversation it was started from. Sessions an agent starts use this relay's accounts and
count against their usage.

**In the conversation list.** A session an agent on this relay started carries **via agent ·
“title”** in the sidebar and under the title in the header, with the title of the conversation
the agent runs in; clicking it opens that conversation while it is still in the list. The
agent's prompts carry the same marker, with its model, as a badge on the message. The relay never
archives these sessions by itself: they stay in the list until you archive or delete them, or the
agent archives one with the tool.

**Longest wait per tool call.** The slider under the switch sets how long one `send`,
`create_session` or `wait` call may wait for a reply: 10 minutes by default, from 2 to 60 minutes
in steps of one minute. The agent can call `wait` again to keep waiting. The limit also applies
to this relay's agents when they wait for a session on a paired relay, so the slider can be moved
whether or not the switch above it is on. A turn that waits is still subject to **Max turn duration**
under **General** (60 minutes by default), which does not know about the wait.

## Security notes

- The auth token guards the API and the Socket.IO channel. A browser signs in once, with the token or with a URL carrying `?token=` (such as the one `oar setup` prints and puts in its QR code), and then holds an HttpOnly cookie for 30 days, marked `Secure` when the relay is reached over HTTPS. Treat the token, and that URL, like a password.
- Keep the config file private (the relay keeps it owner-only) and rotate `authToken` if it is exposed: `oar setup` offers a new token, which signs every device out.
- `localhostOnly` (default `true`) keeps the relay on loopback. Beyond your LAN, use HTTPS through one of the [tunnels](#remote-access) rather than an open port.
- Agents act with the permissions of the user the relay runs as. OAR adds reach, not a sandbox: whoever holds the token can have them run commands on the host. `workspaceRootAllowList` limits the directories conversations may start in.
- Shared conversation links and preview links are public by design: anyone with the URL can read the shared transcript or reach the previewed app, without signing in.
- A [paired relay](#remote-relays) holds a token that opens the other relay completely. The per-relay "Agents may" limit and the "Accept prompts from other relays' agents" switch are honoured by OAR's own traffic, but anyone holding the token can still use the full API: the token is the real boundary. A token entered for a paired relay is stored like the API keys below and never sent to browsers or agents.
- API keys you enter (OpenAI, Cursor) are stored in the relay database on the host and never sent to browsers. Claude and Grok credentials stay with their CLIs on the host.
- Claude Cloud, when you switch it on, reads the Claude CLI's login and uses it against Anthropic API endpoints that are not a documented public API. The token is only read and held in memory, and goes to `api.anthropic.com` only (see [Claude Cloud](#claude-cloud)). A cloud agent works in Anthropic's sandbox, not on your host.
- OAR has no telemetry. Its only request to oar.sh is the update check, which is off until you enable it.

## Troubleshooting

| Symptom                            | What to check                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Banner says *CLI is offline*       | No session worker has reported in during the last 10 seconds, which can be normal on an idle relay. Send a message: the relay starts that conversation's worker, and the banner clears once it connects. If it stays, check `/api/status` and the worker's `worker-<session>.log` in the log directory |
| `oar` exits with *Copilot CLI process error: spawn gh ENOENT* | `oar` runs `gh copilot` after starting the relay, and stops the relay again when that fails. Install the GitHub CLI, or [run only the relay](#start-the-relay) |
| Settings refuses the **SDK** engine | Install or upgrade the Copilot CLI, run `copilot` once, and restart the relay (see [engine choice](#github-copilot--engine-choice)) |
| Messages stuck pending             | Only one relay may run per data directory (a second one exits on the singleton lock), and only one process may own port `3333`. `oar doctor` shows the config and database in use |
| Wrong or old model list            | **🤗 Select Models → Refresh** reruns discovery; `/api/model-variants` shows the Copilot catalog's `source` and `refreshedAt` |
| Clarification card not progressing | Answer via the web card; the turn resumes once the question status becomes `answered` |
| File links fail                    | Verify auth token/cookie and that paths are inside allowed workspace/drive roots |
| Claude missing from New Chat       | Enable it in **⚙️ Settings → Providers → Claude**; the toggle is off by default   |
| Claude reply says it cannot authenticate | Press **Claude settings** on the failed reply, then **Relogin** (or run `claude` on the relay host), and retry the turn |
| Claude Cloud missing from New Chat | Enable it in **⚙️ Settings → Providers → Claude Cloud**; it is off by default and needs a Claude login on the relay host |
| Claude Cloud reply says GitHub is not connected, or the Claude GitHub app has no access | Connect GitHub to the Claude account at [claude.ai/connect-github](https://claude.ai/connect-github), or add the repository to the Claude GitHub app's repository access on GitHub; then send the message again |
| New Chat says *No cloud environment is set* | Choose one in **⚙️ Settings → Providers → Claude Cloud**; an account without any gets its default one when you open claude.ai/code once |
| Grok reply says the CLI was not found | Press **Install Grok CLI** on the failed reply, or install it from **⚙️ Settings → Providers → Grok**; no relay restart is needed afterwards |
| Grok reply says authentication failed | Press **Sign in to Grok** on the failed reply and confirm the device code in a browser |
| Long turn requeued unexpectedly    | Raise or clear **Max turn duration** in Settings (0 = no limit)                  |
| Background agent or shell stopped on its own | It reached the **Background task timeout** (default 4 h); raise it or set 0 for no limit |
| A conversation will not delete     | It is still working: a running turn, one waiting on a question card or approval, or live background tasks. Stop it, then delete |
| A conversation seems wedged        | **☠️ Kill session** in the `⋯` menu stops its worker; retry the turn or send a new message |
| **🌄 Restart web relay** fails with *localhost-only* | The restart endpoint accepts loopback connections only: use it on the relay host or through a tunnel, not over a direct LAN connection |
| `npm install -g @oar-sh/oar` fails with node-gyp or prebuild errors | `better-sqlite3` has no prebuilt binary for your platform; install a C/C++ build toolchain and Python, then retry |
| No usage line under a reply        | Expected for OpenAI, Claude, Claude Cloud, Cursor, and Grok turns; only Copilot turns record plan usage |

## Repository layout

```text
oar/
├── .github/extensions/web-relay/   # Copilot CLI extension for the Extension engine (worker link, ask_user bridge, model snapshots)
├── bin/                            # The `oar` command (oar.js) and a Windows cmd shim for checkouts (bat/oar.bat)
├── docs/                           # Preview-server guide, Copilot BYOK notes, SDK feature tracker
├── server/
│   ├── claude-cloud-worker/        # Claude Cloud session worker (follows a cloud session's event stream; runs no agent itself)
│   ├── claude-worker/              # Claude Agent SDK session worker (turn runner, ask-user bridge, attachments)
│   ├── copilot-worker/             # Copilot SDK engine session worker (steering, background tasks, questions)
│   ├── cursor-worker/              # Cursor Agent SDK session worker (turn runner, mode nudges, auth retry)
│   ├── grok-worker/                # Grok CLI session worker over ACP
│   ├── migrations/                 # Database migrations
│   ├── public/                     # Browser app (index.html, app/ modules, PWA shell)
│   ├── repositories/               # SQLite data access
│   ├── routes/                     # Express route registration
│   ├── services/                   # Relay services (workers, usage, images, tunnels, previews, updates)
│   ├── tools/                      # Diagnostic tools (OpenAI BYOK capture proxy)
│   ├── server.js                   # Entry point: supervisor plus relay runtime
│   └── server-runtime.mjs          # Express + Socket.IO relay server
├── shared/                         # Code shared by the server, the extension, and the workers
│   ├── claude-cloud/               # Claude Cloud API client, credentials reader, repository and branch rules
│   └── worker-runtime/             # Common worker plumbing (relay API client, heartbeat, worker link)
├── tests/                          # Playwright end-to-end suite and its isolated relay harness
├── CHANGELOG.md
├── DEVELOPING.md                   # Development workflows, tests, relay internals
└── README.md
```
