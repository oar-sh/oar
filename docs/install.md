# Installing and running OAR

How to install OAR, start the relay, and keep it up to date. This is the detail behind the [README](../README.md#install); the most complete guide is [Getting started on oar.sh](https://oar.sh/docs/getting-started/install/).

## Prerequisites

You need Node.js plus whatever the runtimes you actually use need. Nothing else is required.

| Requirement | Needed for | Notes |
| ----------- | ---------- | ----- |
| Node.js 22.13 or newer | always | The macOS and Linux installer fetches its own copy when yours is missing or too old; the Windows installer only checks. Running the development test suite needs Node 24 (see [DEVELOPING.md](../DEVELOPING.md#node-version)) |
| GitHub Copilot CLI (`copilot`), signed in | Copilot and OpenAI (BYOK) chats | Install it with `npm install -g @github/copilot`, then run `copilot` once on the relay host and sign in. The relay looks for the CLI's runtime when it starts, so restart the relay after installing or upgrading the CLI. Needs a GitHub Copilot plan that includes Copilot CLI |
| GitHub CLI (`gh`), signed in | `oar copilot`; Extension-engine sessions on Windows; the Copilot card in **Check Usage** | `gh copilot` is built into current GitHub CLI releases, so there is no extension to install. The usage card also accepts a token in `GH_TOKEN` or `GITHUB_TOKEN` |
| OpenAI API key | OpenAI and OpenAI Image chats | Entered in **⚙️ Settings**, stored in the relay database |
| A Claude login on the relay host | Claude chats | Log in from **⚙️ Settings → Providers → Claude → Relogin** (the panel can install the Claude Code CLI first), or run `claude` once on the host. Turns run on the Claude Code build that comes with the Claude Agent SDK, which the relay downloads itself (see [Agent SDKs](#agent-sdks)), so the CLI is needed for the login, not for the chats (see [Claude](providers.md#claude-agent-sdk)). The relay stores no Claude key |
| The same Claude login, from a claude.ai account with GitHub connected | Claude Cloud chats | The Claude GitHub app must be allowed on each repository a cloud chat works on (see [Claude Cloud](providers.md#claude-cloud)) |
| Cursor API key | Cursor chats | Entered in **⚙️ Settings**, stored in the relay database |
| DeepSeek API key | DeepSeek chats | Entered in **⚙️ Settings**, stored in the relay database. No CLI is needed: the turns run on the Claude Code build that comes with the Claude Agent SDK, which the relay downloads itself (see [DeepSeek](providers.md#deepseek)) |
| The npm registry, once per SDK version | Claude, Claude API, DeepSeek and Cursor chats | The relay downloads these providers' agent SDK when you set one up or start its first chat, with your npm config; it does not work offline (see [Agent SDKs](#agent-sdks)) |
| Grok CLI, signed in | Grok chats | Install it and sign in from **⚙️ Settings → Providers → Grok**, or set `XAI_API_KEY` in the relay's environment |
| `cloudflared` (optional) | the built-in Cloudflare tunnel | Not included; install it yourself (see [Cloudflare Tunnel](remote-access.md#optional-remote-internet-access-cloudflare-tunnel)) |
| Python 3, make and a C++ compiler | only where better-sqlite3 ships no SQLite binding: Android (Termux), 32-bit ARM, FreeBSD | OAR builds the binding there with `oar build-native` (see [npm](#npm)). On Termux: `pkg install python clang make` |
| Internet access in the browser (optional) | Markdown, code colours, formulas and the tmux console | The page loads marked, highlight.js, KaTeX 0.19.1 and xterm.js (`@xterm/xterm` 5.5.0 with `@xterm/addon-fit` 0.10.0) from jsDelivr and cdnjs, KaTeX and xterm.js with integrity hashes; none of them comes with OAR, and the relay host needs no access for them. A browser that cannot reach them shows replies as plain text, code without colours, formulas as they were written, and **🖥️ Inspect tmux console** as plain text without colours (for the xterm.js scripts the console tries unpkg before it gives up; the stylesheet comes from jsDelivr only) |
| tmux (optional) | Linux and macOS | Session workers run in detached tmux sessions you can watch from the browser (**🖥️ Inspect tmux console**). Without tmux they run as plain background processes |

## macOS and Linux

```bash
curl -fsSL oar.sh/install | sh
```

The script looks at what the machine has, prints what it is about to do, and asks once. After a yes it installs OAR, writes the config with a fresh auth token, starts the relay, and prints the relay URL with a QR code. Nothing needs root (it refuses to run as root, because OAR installs per user), and everything lands in your home directory:

| The machine has | What the installer does |
| --------------- | ----------------------- |
| Node.js 22.13 or newer whose global npm folder you can write (nvm, fnm, Homebrew, a user prefix) | `npm install -g @oar-sh/oar`, as you would by hand |
| Node.js 22.13 or newer whose global npm folder needs root (a distribution or NodeSource package) | Installs the package into `~/.oar/npm` with your Node.js and puts an `oar` command into `~/.local/bin`. Your npm setup is not changed |
| No Node.js, or an older one | Downloads the current Node.js 24 from nodejs.org into `~/.oar/runtime/node` (checksum verified, about 30 MB), installs the package into `~/.oar/npm` with it, and puts an `oar` command into `~/.local/bin`. Only OAR uses that Node.js; one of your own stays first on `PATH` |

When it puts the command into `~/.local/bin` and that folder is not on your `PATH`, it adds one line to your shell's startup file (`~/.bashrc`, `~/.zshrc`, or `~/.profile`) and says so.

The relay is started as a systemd user service where a systemd user session exists, with lingering enabled, so it is back after a reboot and keeps running while you are logged out. Elsewhere (macOS, containers, WSL without systemd) it is started in the background; after a reboot, `oar start` starts it again.

`--yes` skips the question, for scripts and CI; without a terminal to ask on, the installer stops and says so. `OAR_VERSION=x.y.z` pins a version, `OAR_CHANNEL=beta` follows the beta channel, `OAR_PORT=n` sets the relay port, `OAR_NODE=private` uses OAR's own Node.js even when yours would do, and `OAR_DRY_RUN=1` only prints the plan:

```bash
curl -fsSL oar.sh/install | sh -s -- --yes
curl -fsSL oar.sh/install | OAR_VERSION=0.9.26 OAR_PORT=3400 sh
```

The installer needs `curl` or `wget`, and `tar` when it fetches Node.js. It has no Node.js build for musl systems (Alpine) or for CPUs other than x64 and arm64; there, install Node.js yourself first. Releases before 0.9.8 are installed the same way, but their `oar setup` cannot start the relay: see [Start the relay](#start-the-relay).

Read it before you run it: [oar.sh/install](https://oar.sh/install).

## Windows

```powershell
irm oar.sh/install.ps1 | iex
```

The PowerShell installer (PowerShell 5 or newer) expects Node.js 22.13 or newer to be installed: it checks Node.js, runs `npm install -g @oar-sh/oar`, then `oar setup`. It reads the same `OAR_VERSION`, `OAR_CHANNEL`, and `OAR_DRY_RUN` variables, for example `$env:OAR_VERSION = '0.9.26'` before the command.

## npm

```bash
npm install -g @oar-sh/oar
oar setup
```

Neither OAR nor any of its dependencies has an install script, so npm 12 needs no `--allow-scripts`. The agent SDKs are not in the package: the relay downloads them when a provider needs one (see [Agent SDKs](#agent-sdks)).

better-sqlite3 ships its SQLite binding for Linux, macOS and Windows on x64 and arm64. Anywhere else (Android under Termux, 32-bit ARM, FreeBSD) run `oar build-native` once after the install: it compiles the binding in the installed package and needs Python 3, make and a C++ compiler (on Termux, `pkg install python clang make` first). The relay says so when it starts without one. `oar update` and the **Update** button build it themselves on those platforms; on the others `oar build-native` has nothing to do.

## From a git checkout

```bash
git clone https://github.com/oar-sh/oar
cd oar
npm install
node bin/oar.js setup   # writes server/config.json with a fresh auth token
npm start               # the same as: node server/server.js
```

A checkout keeps all of its state inside the repository (`server/config.json`, `server/data/`, `server/uploads/`, `server/logs/`) and never updates itself. It runs the agent SDKs that `npm install` puts into its `node_modules` instead of downloading them, as long as they are there (see [Agent SDKs](#agent-sdks)). `node server/server.js --port <port> --token <token>` overrides the config for one run without saving it.

You can also write `server/config.json` by hand; every key you leave out takes its default (see the [configuration reference](configuration.md#configuration-reference-serverconfigjson)):

```json
{
  "authToken": "change-me-to-a-long-random-secret",
  "port": 3333,
  "localhostOnly": true
}
```

Development workflows, tests, and relay internals are in [DEVELOPING.md](../DEVELOPING.md).

## Start the relay

*On oar.sh: [First run](https://oar.sh/docs/getting-started/first-run/)*

The macOS and Linux installer starts the relay itself. After a manual install, `oar setup` creates the config and prints the relay URL, but it does not start the relay unless you pass `--start`. `oar` alone, in a terminal, opens a menu with everything below.

- **Any global install:** `oar start` starts the relay in the background (through the systemd user service when one is installed) and prints the relay URL. `oar stop` stops it, `oar restart` restarts it, `oar status` says whether it runs. Both wait for running turns, under the service too; `--now` does not wait (see below).
- **At boot or sign-in:** `oar service install`. On Linux that writes and enables a systemd user service (`~/.config/systemd/user/oar.service`) and enables lingering, so the relay is back after a reboot and keeps running while you are logged out (if lingering cannot be enabled, the service starts at your next login and stops when you log out; `oar service status` says when lingering is off). It starts the relay now, unless one started by hand is still busy; the service then takes over once that one has stopped (`oar start`) or at the next boot. The unit carries the `PATH` of the shell that ran the command, plus `~/.local/bin`, so the relay's sessions find the tools you have: run it from a login shell of your own, not from inside an agent session. It runs the Node that ran the command; after your `PATH` or your Node changed, run it again, then restart the service: `oar restart --now` (a running service is not restarted by the install). The relay's output goes to the journal (`journalctl --user -u oar`), and to `relay-console.log` in the log folder as always. A crash of the relay is relaunched by its own supervisor; after the third crash in 10 minutes systemd starts it again after 2 seconds, then with longer waits up to 5 minutes, and keeps trying (systemd before 254: every 10 seconds). Settings of your own (an environment variable, a memory limit) go in `~/.config/systemd/user/oar.service.d/*.conf`: OAR never writes or deletes those, and `oar service status` lists them. The unit is OAR's own while it is exactly what this version, or 0.9.19, writes for this install; one edited by hand, written by hand, or written for another install (another checkout, the global install beside a checkout) is hand-made: `oar service install`, `remove`, `oar setup --start` and `oar autostart` leave it as it is and name it, and `--replace` replaces (or removes) it, keeping a copy as `oar.service.bak` (numbered when one is there). In a git checkout, `node bin/oar.js service install` installs the same service for the checkout: it runs `node server/server.js` in the checkout, on the checkout's `server/config.json`, data and logs, as `npm start` does (`COPILOT_WEB_RELAY_*` set in the shell is not carried over; put it in a drop-in), and `node bin/oar.js start`, `stop`, `restart` and `status` go through it. On Windows it switches on the same autostart as **⚙️ Settings → General → Autostart (Windows)** → *At sign-in*. On Windows, `oar autostart signin|boot|off` picks the mode, as `oar setup` asks for it: *at boot* (*At system startup* in the web UI) runs the relay headless before anyone signs in and needs one admin confirmation, to switch it on and to switch it off; a declined prompt changes nothing. The prompt appears on the PC's own desktop and is waited for 2 minutes: unanswered by then, the switch is reported as failed, and a prompt confirmed later still runs the switch, so check with `oar autostart status`. A boot task counts as OAR's own only while it is exactly the one OAR registers (the account, the run level, its one action and one boot trigger, its settings); one changed in any of these is hand-made. If the switch itself fails, it puts back the tasks it deleted from their copies (`<task>.task.xml.bak` in `%APPDATA%\oar`) and keeps the copies. OAR changes only entries it generated, in the web UI as in `oar autostart`: a Startup entry, boot task or launcher edited by hand, or one left by another OAR install, is never deleted or written over, and while one would stay beside the new mode or be replaced by it, switching changes nothing and names it. `oar autostart <mode> --replace` replaces them, keeping a copy of each as `<name>.bak` (a launcher's beside it; a task's exported XML, which `schtasks /create /xml` takes back, and a Startup entry's in `%APPDATA%\oar`, since Windows would open a copy left in the Startup folder at sign-in). Both start the relay on the same config, data and logs as `oar start`, and both wait up to 5 minutes for the `%TEMP%` folder and the drive of the data folder, for example a RAM disk that mounts late; after that they start the relay anyway and write a line naming what is still missing to `oar-web-relay-launcher.log` (at system startup) or `oar-web-relay.log` (at sign-in) in `%APPDATA%\oar`. A data folder on a network share is not waited for. `oar service remove` takes it out again. Not available on macOS yet, nor on a Linux without a systemd user session (containers, WSL without systemd): use `oar start` there.
- **With a Copilot terminal session:** `oar copilot` starts the relay in the background if it is not already running, then opens the Copilot CLI (`gh copilot`) in the same shell. A relay that `oar copilot` started stops again when that session ends. It needs the GitHub CLI.

**Restarts and running work.** Session workers are processes of their own. A restart or stop (**🌄 Restart web relay**, the **Update** button, `oar update`, `oar restart`, `oar stop`, and a restart by `oar setup`) waits for running turns, unless you choose **Restart now** or pass `--now`, and the workers keep running through it, background tasks included. That holds under the systemd service too: the relay asks systemd to restart the whole service once its turns are done, so the new relay runs the code on disk, and a stop leaves the unit enabled (it starts again at the next boot, or with `oar start`). The relay starts its session workers outside the service (`systemd-run --user --scope`), so stopping or restarting the service does not end them; a worker on a tmux server or in a process started before 0.9.20 is still inside the service and stops at its first full restart. Under the service, `oar stop --now` and `oar restart --now` go through `systemctl --user` at once, and so do `oar stop` and `oar restart` when the relay does not answer: running turns end. Without the service, `--now` asks the relay not to wait, as **Restart now** does.

To run the relay of a global install in the foreground, start the server the way the systemd unit does:

```bash
COPILOT_WEB_RELAY_CONFIG="$HOME/.oar/config.json" \
COPILOT_WEB_RELAY_DATA_DIR="$HOME/.oar/data" \
COPILOT_WEB_RELAY_LOG_DIR="$HOME/.oar/logs" \
node "$(npm root -g)/@oar-sh/oar/server/server.js"
```

On Windows, point the same three variables at `%APPDATA%\oar\config.json`, `%APPDATA%\oar\data`, and `%APPDATA%\oar\logs`. The directory you start it from becomes the default working directory for new sessions.

Then open the URL that `oar setup` printed (`oar url` prints it again). With access set to this machine only (the default, `localhostOnly` in the config) that is `http://localhost:3333/` on the relay host; reach it from other devices through a [tunnel](remote-access.md), or switch on LAN access with `oar setup --lan`, which also prints a QR code for your phone. The URL carries your token once (`?token=…`); after that, the relay keeps the browser signed in with an HttpOnly cookie.

## The `oar` command

*On oar.sh: [The oar command](https://oar.sh/docs/reference/oar-command/)*

| Command | What it does |
| ------- | ------------ |
| `oar` | In a terminal: a menu with the relay's status (running or stopped, version, URL, port, access, service) and an entry for each command below; arrow keys or digits, Enter, `q`. Without a terminal: the status and the usage |
| `oar start` | Starts the relay in the background, through the systemd user service when one is installed, and prints the relay URL. A relay that is already running is left alone. A git checkout starts only through its service (`node bin/oar.js service install`); without one it uses `npm start` |
| `oar stop [--now]` | Stops the relay through its own API once no turn is running, under the systemd service too (the unit stays enabled). `--now` does not wait: under the service it runs `systemctl --user stop oar`, which ends running turns; without the service it asks the relay to stop at once. Under the service a relay that does not answer is stopped through systemctl (see [Start the relay](#start-the-relay)) |
| `oar restart [--now]` | Restarts a running relay once no turn is running, or starts a stopped one; under the systemd service the relay hands the restart to systemd, which starts the service afresh. `--now` does not wait: under the service `systemctl --user restart oar` (its restart backoff cleared first), which ends running turns; without the service the relay restarts at once. Under the service a relay that does not answer is restarted through systemctl |
| `oar status` | Says whether the relay runs, on which port and with which access, and whether the service is installed. Exit code 0 when it runs, 3 when it does not |
| `oar url` | Prints the relay URL. With LAN access it also prints a QR code; with access for this machine only it says how to get phone access instead. When the running relay reports a tunnel address, that address and its QR code follow |
| `oar setup` | Creates or updates the config. In a terminal it asks, showing the current value (Enter keeps it): a new auth token (which signs every device out), access (this machine only, or LAN), the port and, on Windows, the autostart mode (at sign-in, at boot, or off; see `oar autostart`). Options answer without a question: `--port <port>`, `--lan` or `--local`, `--new-token`, `--autostart signin|boot|off`; `--defaults` keeps everything of an existing config and gives a new one access for this machine only and the first free port from 3333 on. A port must be free, unless the install's own running relay holds it. When the token, the port or the access changed while the relay runs, setup restarts it like `oar restart` (in a terminal it asks first) and waits until it answers with the new settings. `--start` (global installs, used by the installer) also installs the service where a systemd user session exists and starts the relay. `--migrate-from <dir>` copies the relay state of a pre-rename git checkout at `<dir>` (database, config, uploads, logs) into the OAR state root and says what it copied, or why it copied nothing; it runs even after the installer's own migration, and the same `<dir>` again only says it is already migrated. The source is never changed (links in it are copied as what they point to, links inside its folders are skipped and listed), and a relay still running from it blocks the copy. Nothing in the state root is overwritten: a `config.json` already there is kept. The empty database the installer's relay created on its first start (no conversations, no messages) is moved into `backups/<time>/` first, once that relay is stopped (`oar stop`); a database with conversations makes it refuse: move the state root's `data/` folder aside yourself if the checkout's state should replace it. While it copies a database it holds the relay's lock, so no relay starts on it meanwhile. A refused migration stops `oar setup` with exit code 1; `oar copilot --migrate-from` prints why and starts the session anyway |
| `oar service install` \| `remove` \| `status` `[--replace]` | Starts the relay at boot or sign-in: a systemd user service on Linux (at boot with lingering, else at login), also for a git checkout (`node bin/oar.js service …`), the sign-in autostart on Windows. `status` names the unit, whether OAR wrote it for this install or it is hand-made, and its drop-ins. A hand-made unit, or another install's, is left as it is; `--replace` replaces or removes it, keeping a copy. See [Start the relay](#start-the-relay) |
| `oar autostart signin` \| `boot` \| `off` \| `status` | Windows: switches how the relay starts, at sign-in (Startup folder), at boot before anyone signs in (a scheduled task; one admin confirmation to switch it on or off, asked for by this command itself), or not at all, and removes the other mode's entry. `status` prints the mode and each entry, saying whether OAR generated it or it is hand-made, and which other OAR install a stale one starts; hand-made entries are only changed with `--replace`, which keeps a copy of each. On Linux it is `oar service` (`signin` and `boot` install the service, `off` removes it); elsewhere it says it is not supported |
| `oar uninstall [--purge]` | Stops the relay, removes the autostart entries OAR generated (hand-made ones stay and are named) and the Copilot extension wrapper, then removes the package (`npm uninstall -g @oar-sh/oar`, run once `oar` has ended). The data stays; see [Uninstalling](#uninstalling) |
| `oar copilot [-- <args>]` | Starts the relay in the background unless one already answers on its port, then runs `gh copilot` in the same shell, passing `<args>` through (`gh copilot -- <args>`). `--port <port>` finds or starts the relay on that port for this run without changing the config; a config this command creates saves it. `--install-extension` writes or refreshes the user-global Copilot CLI extension wrapper in `~/.copilot/extensions/web-relay/`, then exits; every run does that unless `--no-install-extension` is given. The same options without the word `copilot` (`oar -- <args>`, `oar --install-extension`) still run this command |
| `oar doctor` | Prints the version, Node.js, install mode, state root, config path, port, whether an auth token is set, the tunnel mode and whether the `cloudflared` it needs is installed, the database file in use (`oar.db`, or `copilot.db` on installs from before 0.9.20) with its size, the backup folder with this relay's backups, the last backup's result and the other files there (not rotated), which provider CLIs (`gh`, `claude`, `grok`) answer, and the agent SDKs: their folder and, per SDK, the pinned version, the installed one and its state. It changes nothing |
| `oar sdk` \| `oar sdk install claude\|cursor\|koffi [--reinstall]` | `oar sdk` prints the agent SDK lines of `oar doctor`. `oar sdk install` downloads one SDK (`koffi`: the Windows helper) into the SDK folder without the relay, for a host whose web UI is the problem, and prints npm's output; `--reinstall` installs a ready one again. Exit code 1 when it does not end ready (see [Agent SDKs](#agent-sdks)) |
| `oar backup [--reason <text>]` | Copies the database into the backup folder while the relay runs, as `oar-<version>-<time>-<reason>.db` (`manual` without `--reason`; the reason is cut down to letters, digits and dashes). The copy counts toward `dbBackups.keep`, like the one the relay makes before a new version's first start. It never creates a database. Exit code 1 when no copy could be made, 0 for a copy or a skip (a full disk, a guarded folder), which it says |
| `oar update [--beta] [--to X.Y.Z]` | Global installs: looks up the newest release of your channel in `https://oar.sh/latest.json` (`--beta` for the beta channel), installs it with `npm install -g` (the npm of the Node.js that runs `oar`, into the folder the package is installed in), and asks a running relay to restart once no turn is running. `--to X.Y.Z` installs that version straight from npm, which works even when `OAR_NO_UPDATE_CHECK=1` blocks the lookup |
| `oar --version`, `oar help` | Prints the version, or the usage. An unknown command or option prints the usage and exits with code 2 |

## Where OAR keeps its files

*On oar.sh: [Files and folders](https://oar.sh/docs/reference/files-and-folders/)*

A global install keeps its state in `~/.oar` (`%APPDATA%\oar` on Windows; `OAR_STATE_ROOT` moves it): `config.json`, `data/` (the database, `oar.db`, or `copilot.db` on installs from before 0.9.20, and uploads), `backups/` (the relay's database backups, `oar-<version>-<time>-<reason>.db` with the time in UTC, the last two kept; earlier hand-made ones and `MIGRATION.md` stay there untouched), and `logs/` (`relay-console.log`, a copy of the relay's console; `server.log` and `server-err.log` when `oar` started the relay in the background; and a `worker-<session>.log` per Node session worker), and `sdks/` (the agent SDKs the relay downloaded; `OAR_SDK_DIR` moves it, see [Agent SDKs](#agent-sdks)). Under the systemd service the relay's output goes to the journal instead of `server.log`: `journalctl --user -u oar` (`relay-console.log` is written as always). `npm install -g` updates never touch it. The macOS and Linux installer may add two folders there that are not state: `npm/` (the package, when npm's own global folder was not writable) and `runtime/node/` (OAR's own Node.js, when the machine had none new enough). A git checkout uses `server/config.json`, `server/data/`, `server/backups/`, `server/uploads/`, and `server/logs/` instead.

`COPILOT_WEB_RELAY_CONFIG`, `COPILOT_WEB_RELAY_DATA_DIR`, and `COPILOT_WEB_RELAY_LOG_DIR` override the config file, the data directory, and the log directory. `oar doctor` prints the paths in use.

## Agent SDKs

Claude, Claude API and DeepSeek chats run on the Claude Agent SDK, Cursor chats on the Cursor SDK. Neither comes in the package: the relay downloads the SDK a provider needs from the npm registry, at the exact version this release of OAR pins. Providers you never use cost no download and no disk space. Copilot and OpenAI (BYOK) chats need nothing downloaded: they run on the SDK that comes with the Copilot CLI. Claude Cloud and Grok need no SDK either.

**When the relay downloads an SDK.** Always in the background:

- when you set its provider up: a Claude login, or Claude, Claude API, DeepSeek or Cursor switched on or given a key in **⚙️ Settings → Providers**;
- at the first chat of a provider whose SDK is missing. The chat opens at once and shows *⏳ Installing the Claude Agent SDK on the relay host, once for this version* (or the Cursor SDK); your message waits in the queue and is delivered when the install ends. If the install fails, the chat shows the cause and the message stays queued until a **Retry** in Settings, or the automatic retry, installs the SDK, which delivers it;
- when the relay starts, for each provider in use (switched on, logged in, or with a conversation that is not archived). After an update these are the new release's versions, so the first Claude or Cursor chat after an update may wait for this one-time download. The relay is up meanwhile; the start never waits for it.

**Watching and retrying.** The Claude, Claude API, DeepSeek and Cursor tabs in **⚙️ Settings → Providers** each have a row for their SDK: its state, the pinned and the installed version, the install log, and **Install**, **Cancel**, **Retry** or **Reinstall**. An install's progress (npm's output, the bytes it downloads) is checked every 15 seconds: 5 minutes without any counts as a network failure. An install takes at most 2 hours, which is enough for the Claude SDK (the largest) on a link down to about 0.4 Mbit/s. A download that fails for want of a connection, or stalls like that, is tried again after 1, 5 and 15 minutes; any other failure waits for **Retry** or the next relay start. While a provider's install has failed, its chats show a note with the cause and the Settings tab, and the message stays queued until the SDK is installed (see [Troubleshooting](troubleshooting.md)). On a headless host, `oar sdk` and `oar doctor` show the folder and, per SDK, the pinned version, the installed one and its state, and `oar sdk install claude|cursor|koffi` installs one without the relay (see [The `oar` command](#the-oar-command)).

**Network.** OAR does not work offline for these providers: it needs the npm registry once per SDK version. The download runs the npm next to the relay's Node.js with your npm config, so a registry mirror, a proxy, `cafile`, npm's cache and its `offline` and `prefer-offline` settings apply. npm settings that only a parent process put into the relay's environment, other than these, are left out.

**Disk space.** The SDKs live in `sdks/<sdk>/<version>-<hash>/` in the state root (`~/.oar/sdks`, `%APPDATA%\oar\sdks` on Windows). `OAR_SDK_DIR` moves that folder; on Windows (only there) it must be a local folder, not a network path, and at most 120 characters long. The Claude Agent SDK takes about 360–370 MB on Windows and Linux x64 and about 345–350 MB on macOS arm64, most of it the Claude Code binary in its platform package; the Cursor SDK takes 40–50 MB, the Windows helper (Windows only) about 3 MB. The relay keeps the pinned version and the one before it, and any folder a running session still uses; older ones are deleted at the next start or install, so after an update an SDK can take twice its size for a while. `oar uninstall` leaves the folder with the rest of the state root; `--purge` deletes it with the state root, but a folder that `OAR_SDK_DIR` puts outside the state root stays: delete it yourself.

**What is installed.** Each SDK, and the Windows helper, is installed with `npm ci` from a lockfile that comes with OAR, at exact versions and with npm's scripts disabled, into a new folder that is moved into place once it is complete. A folder counts as installed only when the marker file written last lists its files with their sizes and they match; a half-finished or damaged one is installed again.

**The Windows helper.** On Windows the relay's check that only one relay runs per data folder reads process start times through koffi, which is downloaded on demand too (only on Windows, at every start while it is missing). Its row is **⚙️ Settings → General → This computer → Windows helper**. Like the SDKs, it is installed without scripts: its native binary comes prebuilt in koffi's platform package (`@koromix/koffi-win32-x64` or `-arm64`), which npm picks by itself. Until koffi is there, the check falls back to a simpler test: a lock whose owner's start time is unknown is taken as stale when it was written before the last boot, or when its process id now belongs to a program other than Node.js. The start after koffi arrived has the full check again.

**Platforms.** An SDK is there only where its vendor publishes a build. Without one, the provider's row says *Not available on this platform* and nothing is retried. In the table, *has a build* means the vendor publishes one and npm picks it for that platform; the on-demand install was not tried there yet.

| Platform | Claude Agent SDK | Cursor SDK |
| -------- | ---------------- | ---------- |
| Windows x64 | tested with a turn | has a build |
| Linux x64 (glibc) | tested: installs, and its Claude Code binary runs | has a build |
| Linux arm64 (glibc) | tested in a proot Debian: installs and loads, and a turn ran on the host's Claude Code CLI | tested: installs and loads |
| macOS arm64 and x64 | has a build | has a build |
| Linux with musl (Alpine) | has a build | no musl build: npm installs the glibc one, untested |
| Windows arm64 | has a build | not available |
| Android (Termux), 32-bit ARM, FreeBSD | not available | not available |

On Android, run OAR inside a Debian under proot (for example with `proot-distro`), which counts as Linux arm64.

**From a git checkout.** A checkout gets both SDKs, and koffi, as devDependencies at the same pinned versions with `npm install`, and runs them from its `node_modules`; it downloads nothing and leaves the SDK folder alone. It does so only while those packages are really installed there: after `npm install --omit=dev`, for example, it downloads and uses the SDKs like a global install. `OAR_AGENT_SDK_SOURCE=store` in its environment makes it download and use the SDKs like a global install does, in the same `sdks/` folder of the state root unless `OAR_SDK_DIR` names another.

## Updating

*On oar.sh: [Updates](https://oar.sh/docs/updates/)*

- **Global install:** **⚙️ Settings → General → Check for updates** shows a newer release with an **Update** button, which installs it with npm and restarts the relay once no turn is running. `oar update` does the same from a terminal. Automatic checks are opt-in: **Check for updates automatically** asks oar.sh about twice a day. `OAR_NO_UPDATE_CHECK=1` in the relay's environment blocks every check, manual ones included. A release that pins newer agent SDKs downloads them when the new relay starts, in the background, so the first Claude or Cursor chat after the update may wait for that (see [Agent SDKs](#agent-sdks)); sessions that were running before keep the SDK they started with.
- **Git checkout:** `git pull`, `npm install`, then restart the relay (**🌄 Restart web relay** in the conversation's **︙** menu).
- **From 0.9.13 or older:** a relay before 0.9.14 could keep its database, uploads and config inside the package folder, which `npm install -g` deletes. 0.9.14 to 0.9.22 copied them out during the install; 0.9.23 and later no longer do. Before you update, copy `data/`, `uploads/` and `config.json` from the installed package's `server` folder (`npm root -g`, then `@oar-sh/oar/server`) into a new folder under `rescued-package-data` in the data folder, for example `~/.oar/data/rescued-package-data/before-update/` (`%APPDATA%\oar\data\rescued-package-data\before-update\` on Windows). The first start of the new version takes them over, as it did the copies the install made.

The first start of a new version (in a checkout: of a new commit) copies the database into the backup folder before that version's migrations, and keeps the last two (`dbBackups` in [the configuration](configuration.md)). The in-app update says before it installs whether that copy will be made, or why not (a full disk). To go back, see [Restore a database backup](troubleshooting.md#restore-a-database-backup).

## Uninstalling

`oar uninstall` removes a global install and keeps your data:

1. It stops the relay (waiting for running turns; a relay still busy ends the command, and nothing else is changed). A relay that holds its lock without answering, while it brings over a database or starts, also ends the command: run it again once `oar status` says the relay runs.
2. It removes the autostart entries OAR generated: the boot task and its launcher (one admin confirmation), the Startup entry, or the systemd unit, and the Copilot extension wrapper it wrote for this install. An entry or wrapper edited or made by hand, or one of another install, is left as it is and named.
3. It starts `npm uninstall -g @oar-sh/oar` in the background, which runs once `oar` has ended, and writes its outcome to `oar-uninstall.log` in the OAR `logs` folder. Session workers keep running when the relay stops: npm cannot remove the files a running program holds and leaves them in a hidden `.oar-*` folder beside where the package was. `oar uninstall` names those programs, the log names the folder; delete it once they have ended, at the latest after a reboot.

Your config, database, uploads and logs stay in the state root (`~/.oar`, `%APPDATA%\oar`), and the command prints where. A later install picks them up again. If a step fails, the command stops and says what it has done and what is left; run it again once that is sorted out.

`oar uninstall --purge` also deletes the state root, the database backups in its `backups/` folder and the downloaded agent SDKs in `sdks/` included, after you type `delete`. An SDK folder that `OAR_SDK_DIR` puts outside the state root is not deleted; remove it yourself. Some folders each need a yes of their own: the state root when it lies inside a git checkout, `rescued-package-data` (data an earlier version kept inside its package), and a data folder outside the state root (`dataDir` in the config, or `COPILOT_WEB_RELAY_DATA_DIR`). Whatever you type, `--purge` refuses a state root that is a drive root, your home folder or a folder above it (`C:\Users`), a system folder or a folder above one, a git checkout, or a folder without an OAR config or database in it; such an extra folder is not offered either. With `--purge` the npm log goes to the temp folder.
