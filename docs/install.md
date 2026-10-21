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
| A Claude login on the relay host | Claude chats | Log in from **⚙️ Settings → Providers → Claude → Relogin** (the panel can install the Claude Code CLI first), or run `claude` once on the host. Turns run on the Claude Code build that comes with OAR, so the CLI is needed for the login, not for the chats (see [Claude](providers.md#claude-agent-sdk)). The relay stores no Claude key |
| The same Claude login, from a claude.ai account with GitHub connected | Claude Cloud chats | The Claude GitHub app must be allowed on each repository a cloud chat works on (see [Claude Cloud](providers.md#claude-cloud)) |
| Cursor API key | Cursor chats | Entered in **⚙️ Settings**, stored in the relay database |
| Grok CLI, signed in | Grok chats | Install it and sign in from **⚙️ Settings → Providers → Grok**, or set `XAI_API_KEY` in the relay's environment |
| `cloudflared` (optional) | the built-in Cloudflare tunnel | Not included; install it yourself (see [Cloudflare Tunnel](remote-access.md#optional-remote-internet-access-cloudflare-tunnel)) |
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
curl -fsSL oar.sh/install | OAR_VERSION=0.9.15 OAR_PORT=3400 sh
```

The installer needs `curl` or `wget`, and `tar` when it fetches Node.js. It has no Node.js build for musl systems (Alpine) or for CPUs other than x64 and arm64; there, install Node.js yourself first. Releases before 0.9.8 are installed the same way, but their `oar setup` cannot start the relay: see [Start the relay](#start-the-relay).

Read it before you run it: [oar.sh/install](https://oar.sh/install).

## Windows

```powershell
irm oar.sh/install.ps1 | iex
```

The PowerShell installer (PowerShell 5 or newer) expects Node.js 22.13 or newer to be installed: it checks Node.js, runs `npm install -g @oar-sh/oar`, then `oar setup`. It reads the same `OAR_VERSION`, `OAR_CHANNEL`, and `OAR_DRY_RUN` variables, for example `$env:OAR_VERSION = '0.9.15'` before the command.

## npm

```bash
npm install -g --allow-scripts=@oar-sh/oar,better-sqlite3,koffi @oar-sh/oar
oar setup
```

npm 12 runs no install script it was not told to allow, and two of OAR's dependencies fetch their native binary in one; without `--allow-scripts` the install succeeds there and the relay then fails to start. OAR's own (`@oar-sh/oar`) copies the data an earlier version kept inside the package before npm removes it. npm 10 and 11 accept the flag and need none. The installers and `oar update` pass it themselves.

## From a git checkout

```bash
git clone https://github.com/oar-sh/oar
cd oar
npm install
node bin/oar.js setup   # writes server/config.json with a fresh auth token
npm start               # the same as: node server/server.js
```

A checkout keeps all of its state inside the repository (`server/config.json`, `server/data/`, `server/uploads/`, `server/logs/`) and never updates itself. `node server/server.js --port <port> --token <token>` overrides the config for one run without saving it.

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

- **Any global install:** `oar start` starts the relay in the background (through the systemd user service when one is installed) and prints the relay URL. `oar stop` stops it, `oar restart` restarts it, `oar status` says whether it runs. Without the service, stop and restart wait for running turns; under the service they do not (see below).
- **At boot or sign-in:** `oar service install`. On Linux that writes and enables a systemd user service and enables lingering, so the relay is back after a reboot and keeps running while you are logged out (if lingering cannot be enabled, the service starts at your next login and stops when you log out). It starts the relay now, unless one started by hand is still busy; the service then takes over once that one has stopped (`oar start`) or at the next boot. The unit carries the `PATH` of the shell that ran the command, plus `~/.local/bin`, so the relay's sessions find the tools you have. After your `PATH` changed, run it again, then `oar restart`: a running service is not restarted by it. On Windows it switches on the same autostart as **⚙️ Settings → General → Autostart (Windows)** → *At sign-in*. On Windows, `oar autostart signin|boot|off` picks the mode, as `oar setup` asks for it: *at boot* (*At system startup* in the web UI) runs the relay headless before anyone signs in and needs one admin confirmation, to switch it on and to switch it off; a declined prompt changes nothing. The prompt appears on the PC's own desktop and is waited for 2 minutes: unanswered by then, the switch is reported as failed, and a prompt confirmed later still runs the switch, so check with `oar autostart status`. A boot task counts as OAR's own only while it is exactly the one OAR registers (the account, the run level, its one action and one boot trigger, its settings); one changed in any of these is hand-made. If the switch itself fails, it puts back the tasks it deleted from their copies (`<task>.task.xml.bak` in `%APPDATA%\oar`) and keeps the copies. OAR changes only entries it generated, in the web UI as in `oar autostart`: a Startup entry, boot task or launcher edited by hand, or one left by another OAR install, is never deleted or written over, and while one would stay beside the new mode or be replaced by it, switching changes nothing and names it. `oar autostart <mode> --replace` replaces them, keeping a copy of each as `<name>.bak` (a launcher's beside it; a task's exported XML, which `schtasks /create /xml` takes back, and a Startup entry's in `%APPDATA%\oar`, since Windows would open a copy left in the Startup folder at sign-in). Both start the relay on the same config, data and logs as `oar start`, and both wait up to 5 minutes for the `%TEMP%` folder and the drive of the data folder, for example a RAM disk that mounts late; after that they start the relay anyway and write a line naming what is still missing to `oar-web-relay-launcher.log` (at system startup) or `oar-web-relay.log` (at sign-in) in `%APPDATA%\oar`. A data folder on a network share is not waited for. `oar service remove` takes it out again. Not available on macOS yet, nor on a Linux without a systemd user session (containers, WSL without systemd): use `oar start` there.
- **With a Copilot terminal session:** `oar copilot` starts the relay in the background if it is not already running, then opens the Copilot CLI (`gh copilot`) in the same shell. A relay that `oar copilot` started stops again when that session ends. It needs the GitHub CLI.

**Restarts and running work.** Session workers are processes of their own. A restart or stop the relay performs itself (**🌄 Restart web relay**, the **Update** button, `oar update`, and `oar restart` or `oar stop` without the service) waits for running turns, unless you choose **Restart now**, and the workers keep running through it, background tasks included. Under the systemd service, `oar stop`, `oar restart` and a restart by `oar setup` go through `systemctl --user` at once: they do not wait for running turns, and systemd stops every process of the service with the relay, so running turns end and session workers and their background tasks stop too. Only workers in a tmux session on a tmux server that was already running outside the service (one you started yourself) survive. To keep running work, restart from the web UI instead.

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
| `oar start` | Starts the relay in the background, through the systemd user service when one is installed, and prints the relay URL. A relay that is already running is left alone. Global installs only; a git checkout uses `npm start` |
| `oar stop` | Stops the relay: any relay but the service through its own API, once no turn is running; the systemd service at once, through `systemctl --user stop oar`, which also ends running turns and session workers (see [Start the relay](#start-the-relay)) |
| `oar restart` | Restarts a running relay once no turn is running, or starts a stopped one. The systemd service is restarted at once through `systemctl --user restart oar`, which also ends running turns and session workers |
| `oar status` | Says whether the relay runs, on which port and with which access, and whether the service is installed. Exit code 0 when it runs, 3 when it does not |
| `oar url` | Prints the relay URL. With LAN access it also prints a QR code; with access for this machine only it says how to get phone access instead. When the running relay reports a tunnel address, that address and its QR code follow |
| `oar setup` | Creates or updates the config. In a terminal it asks, showing the current value (Enter keeps it): a new auth token (which signs every device out), access (this machine only, or LAN), the port and, on Windows, the autostart mode (at sign-in, at boot, or off; see `oar autostart`). Options answer without a question: `--port <port>`, `--lan` or `--local`, `--new-token`, `--autostart signin|boot|off`; `--defaults` keeps everything of an existing config and gives a new one access for this machine only and the first free port from 3333 on. A port must be free, unless the install's own running relay holds it. When the token, the port or the access changed while the relay runs, setup restarts it like `oar restart` (in a terminal it asks first) and waits until it answers with the new settings. `--start` (global installs, used by the installer) also installs the service where a systemd user session exists and starts the relay. `--migrate-from <dir>` copies the relay state of a pre-rename git checkout at `<dir>` (database, config, uploads, logs) into the OAR state root and says what it copied, or why it copied nothing; it runs even after the installer's own migration, and the same `<dir>` again only says it is already migrated. The source is never changed (links in it are copied as what they point to, links inside its folders are skipped and listed), and a relay still running from it blocks the copy. Nothing in the state root is overwritten: a `config.json` already there is kept. The empty database the installer's relay created on its first start (no conversations, no messages) is moved into `backups/<time>/` first, once that relay is stopped (`oar stop`); a database with conversations makes it refuse: move the state root's `data/` folder aside yourself if the checkout's state should replace it. While it copies a database it holds the relay's lock, so no relay starts on it meanwhile. A refused migration stops `oar setup` with exit code 1; `oar copilot --migrate-from` prints why and starts the session anyway |
| `oar service install` \| `remove` \| `status` | Starts the relay at boot or sign-in: a systemd user service on Linux (at boot with lingering, else at login), the sign-in autostart on Windows. See [Start the relay](#start-the-relay) |
| `oar autostart signin` \| `boot` \| `off` \| `status` | Windows: switches how the relay starts, at sign-in (Startup folder), at boot before anyone signs in (a scheduled task; one admin confirmation to switch it on or off, asked for by this command itself), or not at all, and removes the other mode's entry. `status` prints the mode and each entry, saying whether OAR generated it or it is hand-made, and which other OAR install a stale one starts; hand-made entries are only changed with `--replace`, which keeps a copy of each. On Linux it is `oar service` (`signin` and `boot` install the service, `off` removes it); elsewhere it says it is not supported |
| `oar uninstall [--purge]` | Stops the relay, removes the autostart entries OAR generated (hand-made ones stay and are named) and the Copilot extension wrapper, then removes the package (`npm uninstall -g @oar-sh/oar`, run once `oar` has ended). The data stays; see [Uninstalling](#uninstalling) |
| `oar copilot [-- <args>]` | Starts the relay in the background unless one already answers on its port, then runs `gh copilot` in the same shell, passing `<args>` through (`gh copilot -- <args>`). `--port <port>` finds or starts the relay on that port for this run without changing the config; a config this command creates saves it. `--install-extension` writes or refreshes the user-global Copilot CLI extension wrapper in `~/.copilot/extensions/web-relay/`, then exits; every run does that unless `--no-install-extension` is given. The same options without the word `copilot` (`oar -- <args>`, `oar --install-extension`) still run this command |
| `oar doctor` | Prints the version, Node.js, install mode, state root, config path, port, whether an auth token is set, the tunnel mode and whether the `cloudflared` it needs is installed, the database path and size, and which provider CLIs (`gh`, `claude`, `grok`) answer. It changes nothing |
| `oar update [--beta] [--to X.Y.Z]` | Global installs: looks up the newest release of your channel in `https://oar.sh/latest.json` (`--beta` for the beta channel), installs it with `npm install -g` (the npm of the Node.js that runs `oar`, into the folder the package is installed in), and asks a running relay to restart once no turn is running. `--to X.Y.Z` installs that version straight from npm, which works even when `OAR_NO_UPDATE_CHECK=1` blocks the lookup |
| `oar --version`, `oar help` | Prints the version, or the usage. An unknown command or option prints the usage and exits with code 2 |

## Where OAR keeps its files

*On oar.sh: [Files and folders](https://oar.sh/docs/reference/files-and-folders/)*

A global install keeps its state in `~/.oar` (`%APPDATA%\oar` on Windows; `OAR_STATE_ROOT` moves it): `config.json`, `data/` (the database and uploads), and `logs/` (`relay-console.log`, a copy of the relay's console; `server.log` and `server-err.log` when `oar` started the relay in the background; and a `worker-<session>.log` per Node session worker). Under the systemd service the relay's output goes to the journal instead of `server.log`: `journalctl --user -u oar`. `npm install -g` updates never touch it. The macOS and Linux installer may add two folders there that are not state: `npm/` (the package, when npm's own global folder was not writable) and `runtime/node/` (OAR's own Node.js, when the machine had none new enough). A git checkout uses `server/config.json`, `server/data/`, `server/uploads/`, and `server/logs/` instead.

`COPILOT_WEB_RELAY_CONFIG`, `COPILOT_WEB_RELAY_DATA_DIR`, and `COPILOT_WEB_RELAY_LOG_DIR` override the config file, the data directory, and the log directory. `oar doctor` prints the paths in use.

## Updating

*On oar.sh: [Updates](https://oar.sh/docs/updates/)*

- **Global install:** **⚙️ Settings → General → Check for updates** shows a newer release with an **Update** button, which installs it with npm and restarts the relay once no turn is running. `oar update` does the same from a terminal. Automatic checks are opt-in: **Check for updates automatically** asks oar.sh about twice a day. `OAR_NO_UPDATE_CHECK=1` in the relay's environment blocks every check, manual ones included.
- **Git checkout:** `git pull`, `npm install`, then restart the relay (**🌄 Restart web relay** in the conversation's `⋯` menu).

## Uninstalling

`oar uninstall` removes a global install and keeps your data:

1. It stops the relay (waiting for running turns; a relay still busy ends the command, and nothing else is changed). A relay that holds its lock without answering, while it brings over a database or starts, also ends the command: run it again once `oar status` says the relay runs.
2. It removes the autostart entries OAR generated: the boot task and its launcher (one admin confirmation), the Startup entry, or the systemd unit, and the Copilot extension wrapper it wrote for this install. An entry or wrapper edited or made by hand, or one of another install, is left as it is and named.
3. It starts `npm uninstall -g @oar-sh/oar` in the background, which runs once `oar` has ended, and writes its outcome to `oar-uninstall.log` in the OAR `logs` folder. Session workers keep running when the relay stops: npm cannot remove the files a running program holds and leaves them in a hidden `.oar-*` folder beside where the package was. `oar uninstall` names those programs, the log names the folder; delete it once they have ended, at the latest after a reboot.

Your config, database, uploads and logs stay in the state root (`~/.oar`, `%APPDATA%\oar`), and the command prints where. A later install picks them up again. If a step fails, the command stops and says what it has done and what is left; run it again once that is sorted out.

`oar uninstall --purge` also deletes the state root, after you type `delete`. Some folders each need a yes of their own: the state root when it lies inside a git checkout, `rescued-package-data` (data an earlier version kept inside its package), and a data folder outside the state root (`dataDir` in the config, or `COPILOT_WEB_RELAY_DATA_DIR`). Whatever you type, `--purge` refuses a state root that is a drive root, your home folder or a folder above it (`C:\Users`), a system folder or a folder above one, a git checkout, or a folder without an OAR config or database in it; such an extra folder is not offered either. With `--purge` the npm log goes to the temp folder.
