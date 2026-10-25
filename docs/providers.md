# Providers

The runtimes OAR drives, what each needs, and what each conversation can do with it. This is the detail behind the [README](../README.md#runtimes); the most complete guide is [Providers on oar.sh](https://oar.sh/docs/providers/overview/).

The runtime (called the *provider* in the UI) is chosen in **New Chat** and then fixed for that conversation, also before its first message: the composer offers only that provider's models and states this above the input — `🔒 Session locked to GitHub Copilot / OpenAI / OpenAI Image / Claude SDK / ☁ Claude Cloud / Cursor SDK / Grok / DeepSeek models.`, colour-coded per provider. For another provider, start a new chat. OpenAI and Grok sessions also pin one exact model once the first message is sent, which the note names in parentheses and the model dropdown shows as a disabled `🔒` entry.

A conversation that has no message and nothing queued yet is moved back to Copilot when its provider goes away, so it never points at a runtime that cannot start: Claude and Grok when you switch them off, OpenAI, Cursor and DeepSeek when you remove their key (switching those off only takes them out of **New Chat**). Removing the OpenAI, Cursor or DeepSeek key is refused as long as any conversation of that provider, archived ones and OpenAI Image chats included, has a message or a queued one; switch the provider off instead. Conversations of other providers are left alone, and so are Claude Cloud's: switching it off only takes it out of **New Chat**.

| Runtime | Enable via | Auth | Notes |
| ------- | ---------- | ---- | ----- |
| **Copilot** (default) | always available | the relay host's Copilot CLI login | Two engines: the headless **SDK** worker (default) or the Copilot CLI with OAR's **Extension**. The only runtime that reports Copilot usage |
| **OpenAI (BYOK)** | ⚙️ Settings → Providers → OpenAI | your API key, stored in the relay database | Runs the Copilot runtime, on either engine, against an OpenAI-compatible endpoint |
| **OpenAI Image (BYOK)** | ⚙️ Settings → Providers → OpenAI | the same key | The relay calls the OpenAI Images API itself; a chat whose replies are images |
| **Claude (Agent SDK)** | ⚙️ Settings → Providers → Claude | the relay host's Claude login, **switchable from the panel** | A dedicated Node worker per conversation. The Claude Code CLI can be installed and updated from the panel |
| **Claude Cloud** | ⚙️ Settings → Providers → Claude Cloud (off by default) | the relay host's Claude login (a claude.ai account), read from the Claude CLI | Claude Code in a sandbox at Anthropic, on a clone of a GitHub repository. Results come back as pushed branches; billed to that Claude account. Uses API endpoints that are not a documented public API (see [Claude Cloud](#claude-cloud)) |
| **Cursor (Agent SDK)** | ⚙️ Settings → Providers → Cursor | your Cursor API key, stored in the relay database | A dedicated Node worker per conversation through the Cursor Agent SDK |
| **Grok (CLI ACP)** | ⚙️ Settings → Providers → Grok | the relay host's Grok CLI login, **sign in and out from the panel** | Drives the Grok CLI's `grok agent stdio` over ACP. The CLI can be installed and updated from the panel |
| **DeepSeek** | ⚙️ Settings → Providers → DeepSeek | your DeepSeek API key, stored in the relay database | Runs Claude Code (bundled with the Agent SDK) on the relay host against DeepSeek's Anthropic-compatible API; billed to the DeepSeek account |

## GitHub Copilot — engine choice

*On oar.sh: [GitHub Copilot](https://oar.sh/docs/providers/github-copilot/)*

Copilot conversations, and OpenAI (BYOK) ones, run on one of two engines, chosen in **⚙️ Settings → Providers → Copilot → Copilot engine**. The setting is per relay and is read whenever a conversation's worker starts; sessions already running keep their engine until their worker restarts.

| Engine | What runs | Notes |
| ------ | --------- | ----- |
| **SDK** (default) | A headless Node worker per conversation, driving the Copilot CLI's bundled SDK runtime | Needs only a Copilot CLI that is installed and signed in; there is no extension to install or keep in sync. This engine has [mid-turn steering](web-ui.md#while-a-turn-runs), the [background task panel](web-ui.md#background-tasks) with a working **Stop**, **Cancel** on a steered message the runtime has not picked up yet, and multi-select question cards, for every Copilot model, hosted or BYOK. There is no TUI: the tmux console shows the worker's log |
| **Extension** | The Copilot CLI in a terminal session with OAR's web-relay extension loaded | The engine OAR started with. **🖥️ Inspect tmux console** shows the live Copilot TUI (Linux and macOS, with tmux). Messages sent during a turn queue behind it |

The SDK engine has been the default since 0.9.2. A relay where nobody has saved a choice uses it whenever it can and falls back to **Extension** when it cannot; a saved choice always wins. Saving **SDK** is refused, with the reason shown in place of the engine description, when:

- *"The Copilot SDK was not found when the relay started (COPILOT_SDK_PATH did not resolve)…"*: the relay found no Copilot CLI runtime at startup. It looks in the Copilot CLI's package cache, newest version first (`~/.cache/copilot/pkg` on Linux, `~/Library/Application Support/copilot/pkg` on macOS, `%LOCALAPPDATA%\copilot\pkg` on Windows; `COPILOT_PKG_DIR` adds a location), unless `COPILOT_SDK_PATH` names the runtime's `copilot-sdk` directory directly. Install or upgrade the Copilot CLI, run it once, **and restart the relay**: the launch environment is snapshotted at startup, so a CLI installed since then is not visible yet.
- *"The SDK engine requires session worker routing, which is disabled on this relay (SESSION_WORKER_ROUTING_ENABLED)…"*: with routing off no SDK worker is ever spawned. Turn **Session worker routing** back on in **⚙️ Settings → Features** (it is on by default) and restart the relay.

A refusal never changes the stored engine; the select snaps back to the engine the relay actually runs.

SDK-engine turns report their own per-turn billing to the relay, which appears as the **Last SDK worker turn** section on the Copilot card in **Check Usage**. The card's meters come from the account-level quota API and are correct for both engines.

## OpenAI (BYOK) and OpenAI Image

*On oar.sh: [OpenAI](https://oar.sh/docs/providers/openai/)*

Save your key in **⚙️ Settings → Providers → OpenAI**, together with the **OpenAI model ID** (default `gpt-4o`) and an optional **Base URL** (default `https://api.openai.com/v1`). **Enable OpenAI API key for New Chat model selection** is on once a key is saved, and saving discovers the endpoint's models from `/v1/models`.

- **OpenAI (BYOK)** conversations run the Copilot runtime against that endpoint with your key, on whichever Copilot engine is selected.
- **OpenAI Image (BYOK)** conversations are chats whose replies are images. **New Chat** asks for **Quality** and **Size** instead of reasoning effort, and **Edit this image** under a generated image iterates on it. The relay calls the OpenAI Images API itself (`/images/generations`, or `/images/edits` with an attached or generated image) on both Copilot engines; these turns never go to the Copilot runtime.

## Claude (Agent SDK)

*On oar.sh: [Claude](https://oar.sh/docs/providers/claude/)*

Turn on **⚙️ Settings → Providers → Claude → Enable Claude for New Chat model selection**, and set the default model under **Claude model ID**. The relay authenticates through the Claude credentials on the host machine (`~/.claude`), so there is no key to enter.

Claude turns run on the Claude Code build bundled with the Agent SDK, so they need no Claude Code CLI on the host. Once the CLI is installed or updated from the panel (see [below](#installing-a-provider-cli-from-the-relay)) and the relay has restarted, turns run on that CLI instead; `CLAUDE_CODE_EXECUTABLE` in the relay's environment names one too. The CLI itself is needed for the account row, **Relogin** and **Logout**, and for Claude Cloud's login.

**Commit attribution.** Commits an agent makes in a Claude session end with `Co-authored-by: Open Agent Relay (<model>) <no-reply@oar.sh>` — the model's name in the parentheses, e.g. `Claude Fable 5.1` — and pull request bodies with `🤖 Generated with [Open Agent Relay](https://oar.sh)`. The same tab has the choice: **OAR** (default), **vanilla** (Claude Code's own `Co-Authored-By: Claude …` lines) or **off** (no attribution). A repo folder can override it for all of its Claude sessions from the **🧠** context modal. A change reaches a running session with its next message (a switch back to vanilla restarts the session's CLI between turns). [Claude Cloud](#claude-cloud) chats follow the same setting. Other providers are not affected: their tools have no such setting.

**Background command limit.** **Claude background command limit** in the same tab (30 min to 8 h in 30-minute steps, default 2 h, saved with **Save Claude settings**) sets how long a command Claude runs in the background may take before Claude Code stops it, when Claude does not give the command a timeout of its own. Claude can still ask for up to 8 h for a single command. A command Claude runs in the foreground moves to the background after 2 minutes, so the turn goes on while it runs; commands that start with `sleep`, and commands of sub-agents, stay in the foreground and may then take up to the limit. Claude is also told the limit, to write the full output of long commands to a log file instead of piping it into `tail` or `head`, and to start runs that must survive a session restart detached with `nohup`. The CLI reads the limit when it starts: a change applies to Claude sessions started after you save, and a running session keeps its limit until it restarts. Claude Cloud chats are not affected.

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
- **Mid-turn steering** with **Steer** / **Queue**, **Stop** on the reply bubble, and **Resend** for steered messages a Stop cut off (see [While a turn runs](web-ui.md#while-a-turn-runs))
- Background tasks that outlive the reply that started them, in the composer's task panel, including **Ultracode** workflow trees (see [Background tasks](web-ui.md#background-tasks))
- Session continuity across worker restarts — the native Agent SDK session id is stored and resumed
- Real context-window metrics, reported after each turn, and a per-conversation auto-compact window (see [Usage and context](web-ui.md#usage-and-context))

Differences from Copilot conversations:

- Cancelling one individual subagent works only for backgrounded ones; a subagent running inside the current turn can be stopped only by stopping the whole turn
- Claude turns are not included in the Copilot usage line, and no usage line is attached to their replies (Claude's own plan limits appear in **Check Usage**)
- The browsable **Session** root points at the Agent SDK's project directory rather than a Copilot session-state folder

## Claude Cloud

*On oar.sh: [Claude Cloud](https://oar.sh/docs/providers/claude-cloud/)*

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
- A **Claude Cloud** card in **Check Usage** with the account's cloud credit and the cost Anthropic reports for this relay's cloud sessions, and the **🧠** button for the session's context use (see [Usage and context](web-ui.md#usage-and-context))
- A failure the relay can name says what to do: log in again, connect GitHub, give the Claude GitHub app access to the repository, choose an environment

**What does not.**

- No relay modes, no reasoning effort and no context size: the three selectors are hidden. The model is chosen in **New Chat** and can be changed between turns in the composer like a local Claude chat's (the sandbox switches before the next message)
- No mid-turn steering: a message sent during a turn waits for the turn to end
- Nothing from the relay host reaches the sandbox: attachments other than images are refused, there is no working directory to change and no **Session** folder to browse
- No relay tools inside the sandbox: no `preview`, no `remote_relay`, no media embedded by host path
- No background task panel

**Started by an agent.** An agent in another session can start a cloud chat with the `remote_relay` tool, naming the repository and, if it wants one, the branch (`repo` and `branch`): an agent on a [paired relay](agents-together.md#remote-relays), under the rules for starting any session from there, or an agent on this relay once [agent sessions](agents-together.md#agent-sessions) are switched on. The same checks apply as in **New Chat** (the provider is on, an environment is set, the repository is on GitHub), and a chat without a requested model starts with the tab's default model. It can also read, prompt, wait for and stop a cloud chat you created.

**What OAR does with the Claude login.** Claude Cloud uses the login the Claude CLI keeps on the relay host (`.credentials.json` in `~/.claude`, or in `CLAUDE_CONFIG_DIR`) to call the Anthropic API endpoints the Claude CLI itself uses for cloud sessions and account usage. **These endpoints are not a documented public API.** Anthropic can change them without notice; cloud chats and the live usage figures then fail with a note until OAR is updated. If you are not comfortable with a program other than the CLI using its login this way, leave the provider off.

- The relay and its cloud workers only **read** the access token. It is sent as the bearer token to `https://api.anthropic.com` and to no other host. (OAR's own tests point the client at a fake API on the same machine; that setting accepts a loopback address and nothing else.)
- It is held in memory only. It is never written to the database or to a log, never sent to the browser and never put into an error message. Each cloud worker reads the credentials file itself, so nothing is passed along at launch.
- It is never refreshed by OAR, and the refresh token is never used. The CLI keeps its own login fresh; when the token has run out, the relay — and a cloud chat's worker, through the relay — reads the file again and at most once in five minutes has the CLI check its own login (`claude auth status`, which refreshes a login whose refresh token is still good), then retries. A login that is still expired ends the turn with a note to log in again.
- While the switch is off, the relay asks Anthropic for nothing with this login: it lists no environments and reads no account usage. Only a cloud conversation from before still talks to its session, when you write to it, delete it or archive it.
- The provider is off by default. Switching it on is the consent for all of the above.

`CLAUDE_CODE_OAUTH_TOKEN` in the relay's environment is used instead of the credentials file when it is set. That is the one case in which the relay passes the login on, and only to Claude Cloud and Claude workers: under tmux they get the variable through a file only the relay's user can read, which the worker's shell reads once and deletes. Workers of other providers are started without it, with or without tmux (see [Environment variables](configuration.md#environment-variables)).

## Cursor (Agent SDK)

*On oar.sh: [Cursor](https://oar.sh/docs/providers/cursor/)*

Paste your Cursor API key in **⚙️ Settings → Providers → Cursor**; **Enable Cursor for New Chat model selection** is on once a key is saved. Saving the key runs model discovery and also discovers each model's supported reasoning-effort tiers; use **🤗 Select Models → Cursor SDK** to choose which models appear in the composer (the configured default model, `composer-2.5` unless you change it, always stays enabled).

What Cursor conversations support:

- Per-message model and reasoning effort — effort tiers come from per-model discovery, and `none` means the model's default behavior
- All four relay modes — `plan` uses the SDK's native plan mode and produces a **Plan ready** board; `ask` and `autopilot` ride as instructions on the message text, injected only when the mode changes
- Live reply streaming, question cards, and **Stop** to abort the running turn
- The browsable **Session** root points at the worker's per-session agent store, created on the session's first turn
- Expired cached agent handles are recreated and retried automatically once — a second auth failure means the API key itself is invalid

Like Claude, Cursor turns are not included in the Copilot usage line and no usage line is attached to their replies. Cursor spend is tracked separately in **Check Usage**; set your monthly pool allowances and billing reset day under **⚙️ Settings → Providers → Cursor → Cursor monthly plan allowance**. The optional **Dashboard session token** in the same panel unlocks the live *Plan usage (total)*, *Auto + Composer* and *API* bars; it is detected automatically from the host's Cursor IDE login when there is one, and headless hosts can set `CURSOR_SESSION_TOKEN` instead.

## Grok (CLI ACP)

*On oar.sh: [Grok](https://oar.sh/docs/providers/grok/)*

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

## DeepSeek

Paste your DeepSeek API key in **⚙️ Settings → Providers → DeepSeek**; **Enable DeepSeek for New Chat model selection** is on once a key is saved. Saving the key asks DeepSeek which models it serves (`GET /models`), and **🤗 Select Models → DeepSeek** chooses which of them appear in the composer. Without an answer from DeepSeek the tab offers `deepseek-flash` and `deepseek-v4-pro`. The default model is `deepseek-flash` unless you choose another one on the tab.

A DeepSeek chat runs Claude Code on the relay host, the build bundled with the Agent SDK, against DeepSeek's [Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api). The agent works in the chat's folder with Claude Code's tools, and DeepSeek's model does the thinking. The turns are billed to the DeepSeek account the key belongs to.

What DeepSeek conversations support:

- All four relay modes. `plan` produces a **Plan ready** board, as in a Claude chat.
- Tools on the relay host, question cards (including multi-select), sub-agents, live reply streaming with thoughts, **Mid-turn steering**, **Stop**, and background tasks in the composer's task panel. The preview and `remote_relay` tools are there as well.
- Per-message reasoning effort: `low`, `high` or `max`, with `high` the default. A changed effort restarts the session's Claude Code between turns; the conversation continues where it was. DeepSeek's thinking cannot be switched off from OAR, because Claude Code never asks DeepSeek for that. An effort of `none` coming from another relay runs as `low`.
- Switching models between turns, which restarts the session's Claude Code like an effort change. `deepseek-v4-pro` takes no images: an image you attach goes to it as a file path, and a switch to it is refused once the chat holds images.
- Sub-agents run on the chat's model: one the agent asks for as "opus" or "sonnet", or without a model, gets the chat's model; one asked for as "haiku" gets DeepSeek Flash. Their badges name the DeepSeek model.
- Context metrics with DeepSeek's 1M window. The chat compacts at 400K tokens unless you set another window in the **🧠** modal.
- Session continuity across worker restarts.
- Commit attribution: commits end with `Co-authored-by: Open Agent Relay (DeepSeek Flash) <no-reply@oar.sh>`, with the name of the model in use. **Off** on the DeepSeek tab leaves the line out. A folder's override from the **🧠** modal applies as for Claude; its *vanilla* setting is read as OAR, because Claude Code's own lines would credit Claude.
- A turn that DeepSeek refuses because the balance is used up or the key is not accepted ends with a note and buttons: **Top up DeepSeek** and **DeepSeek settings**.

What stays on the relay host and what goes to DeepSeek:

- The key stays in the relay database and is never sent to browsers. It reaches only the workers of DeepSeek chats, under tmux through a file only the relay's user can read. Inside a worker it becomes Claude Code's bearer token for DeepSeek's endpoint and nothing else.
- Claude Code in a DeepSeek chat keeps its state (sessions, transcripts, settings) in `deepseek-claude` in the relay's data folder. Your own `~/.claude` stays out of it: the host's Claude login, global skills, plugins and MCP servers are not used. The repository's own `CLAUDE.md` and `.claude/` folder still apply.
- Deleting a DeepSeek chat removes its Claude Code session from `deepseek-claude`: the transcript, the session's folders, the files its stopped Claude Code left (its registration, hook environment and shell snapshot), and the project folder once no other session uses it. The spend it added stays in the DeepSeek card's totals.
- The relay switches off Claude Code's own traffic to Anthropic (updates, telemetry). With that, a DeepSeek turn talked to DeepSeek only (measured 2026-10-24).
- Everything the agent reads and writes as part of a turn goes to DeepSeek: the prompts, the files it opens and the output of its commands.
- DeepSeek gets the same session context as any Claude Code chat: the system prompt with the folder's path, the date and the git status of the folder's repository (branch, recent commits, changed files), the `CLAUDE.md` files and the tool results.
- Claude Code's WebSearch runs on DeepSeek's Search API: DeepSeek bills each search from 2026-10-31, and the DeepSeek card counts them. WebFetch does not: Claude Code fetches the page itself from the relay host and has the helper model (DeepSeek Flash) summarise it. That costs Flash tokens, booked like any other turn's, and no fetch request.

The **Advanced** section of the tab takes another base URL, for a proxy for example. It must be `https:`, or `http:` on the same machine. The key is sent to that address and nowhere else.

Like Claude chats, DeepSeek turns are not included in the Copilot usage line. The Claude plan limits and the usage-limit pause do not apply to them either.

## Installing a provider CLI from the relay

Grok runs as a CLI on the relay host, and Claude's login is managed with the Claude Code CLI there.
The failure mode used to be a dead end: a turn fails with *"Grok CLI was not found on PATH"* and
the only fix is a shell on the host — the one thing the relay exists to avoid. The Copilot, Claude, and Grok sub-tabs therefore carry a CLI row at the top:

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
  with, and remembers it across restarts. New Grok sessions use it at once, with no relay restart;
  sessions already running keep the binary they started with. Claude sessions run on the installed
  CLI, rather than on the build bundled with the Agent SDK, only after the next relay restart.
- **Update** runs the CLI's own updater (`grok update`, `claude update`), not the install script again.
- If your Claude was installed with npm into a folder the relay user cannot write, `claude doctor`
  says so and the button becomes **Switch to native installer** — Anthropic's own recommended fix.
  The npm copy stays where it is; the native build takes precedence on PATH.
- The **Copilot** row is read-only: that CLI is managed with npm on the host, so there is nothing
  the relay could usefully run.

When a turn fails because a CLI is missing or signed out, the failed reply itself carries the fix as
a button — **Install Grok CLI**, **Sign in to Grok**, **Claude settings** — which opens the right
panel and, for an install, the same confirmation sheet.

## Models

*On oar.sh: [Models and reasoning](https://oar.sh/docs/providers/models-and-reasoning/)*

The composer's model picker is the union of every enabled provider's catalog, filtered to the models the active conversation's provider can actually serve:

- **Copilot** models are discovered from the installed Copilot CLI runtime a few seconds after the relay starts, and refreshed by the sessions that run on it. Each model shows the reasoning efforts and context window the runtime reports. The list starts with `auto`, then groups models by vendor (OpenAI, Anthropic, Google, xAI, Microsoft, Azure OpenAI, Moonshot AI, then any others alphabetically), newest version first. Before the first discovery, a fresh relay offers a curated set: `gpt-5.4`, `gpt-5.4-mini` (the default), `gpt-5.3-codex`, `claude-sonnet-4.6`, and `claude-haiku-4.5`.
- **OpenAI (BYOK)** models are discovered from `/v1/models` when the key is saved or re-enabled.
- **Claude** models are discovered from the Agent SDK when the provider is enabled. Bracketed `[1m]` long-context variants (such as `claude-opus-5[1m]`) do not appear as separate entries; they surface as a 1M option in the composer's context-size dropdown for the base model.
- **Claude Cloud** has no discovery of its own: its picker offers the Claude provider's models under their plain ids, plus the tab's default model.
- **Cursor** models (and their per-model reasoning-effort tiers) are discovered when the API key is saved or the provider is re-enabled.
- **Grok** models are discovered from the Grok CLI over ACP when the provider is enabled, after a sign-in, and after a CLI install from the panel.
- **DeepSeek** models are discovered from DeepSeek's `/models` when the key is saved, the provider is re-enabled, or the base URL changes. When discovery fails the stored list is kept, and before the first discovery the tab offers `deepseek-flash` and `deepseek-v4-pro`.

Use **🤗 Select Models** to choose which variants show up in the composer, then **💾 Save enabled models**; **Refresh** reruns discovery for every enabled runtime. The modal has one tab per runtime — **Copilot**, **OpenAI**, **Claude SDK**, **Cursor SDK**, **Grok**, **DeepSeek** — and each tab lists only the models that runtime serves; there is no cross-runtime switching inside a conversation. Claude Cloud has no tab there.
