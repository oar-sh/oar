# Changelog

All notable changes to OAR are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.9.14] — 2026-10-21

Highlights: a relay started by Windows autostart, or by a plain
`gh copilot`, now runs on the same data folder as `oar start`, outside the
installed package, so an update no longer takes its conversations with it;
the update copies that data before npm removes the old version, and the
relay takes it over at its next start (read the upgrade note first). A
relay never moves to another database unannounced, a lock an unclean end
left no longer blocks the next start, autostart waits for a late drive, and
Cursor conversations keep their agent across updates. An agent can ask to
be woken when the relay runs again (`relay_restarted`), its preview tool
reaches only its own conversation's previews, approval cards take a choice
instead of typed text, and a conversation whose folder is gone says so.

### Upgrade notes

- **Windows autostart users, and anyone whose relay a plain `gh copilot`
  started: save your data before this update.** Before 0.9.14, those relays
  ran on the database and uploads inside the installed package, and
  `npm i -g` deletes them with the old version. This update copies them
  first, while it installs, to `rescued-package-data/<time>/` in the OAR
  data folder (`%APPDATA%\oar\data`, `~/.oar/data`), and the relay takes
  the copy over at its next start. npm 10 and 11 run that copy (11.21 with
  a warning), and if it fails they put the old version back with its data.
  npm 12 skips it unless `@oar-sh/oar` is allowed: the install then
  succeeds and the old data is gone. With `strict-allow-scripts`, npm 11
  and 12 refuse the install and change nothing; `--ignore-scripts` skips
  the copy everywhere, and the native modules (better-sqlite3, koffi) too,
  so the relay cannot start afterwards: never update OAR with
  `--ignore-scripts`. On npm 12, update with the relay stopped:
  `npm i -g @oar-sh/oar --allow-scripts=@oar-sh/oar,better-sqlite3,koffi`.
  An `allow-scripts` entry in `.npmrc` does not help the **Update** button
  or `oar update` of 0.9.13: their own `--allow-scripts` replaces it. To be
  safe, do this update by hand:
  1. Close every `gh copilot` session (its extension starts the relay
     again), then `oar stop`, and wait until `oar status` says it is not
     running. If 0.9.13's `oar stop` does not stop a relay the
     system-startup launcher started, end the relay before installing:
     end the relay's processes in Task Manager (node.exe running OAR).
  2. Run `npm root -g` and open `<that folder>/@oar-sh/oar/server`
     (usually `%APPDATA%\npm\node_modules\@oar-sh\oar\server`). Copy
     **both** the `data` and the `uploads` folders, with every file in
     them, to a safe place.
  3. `npm i -g @oar-sh/oar --allow-scripts=@oar-sh/oar,better-sqlite3,koffi`.
  4. Before starting the relay, copy both folders back into the same
     `server` folder.
  5. `oar start`. In `relay-console.log` in the OAR `logs` folder, look
     for `[data] Brought over the database …`: your conversations should
     be back. A database that was already in the OAR data folder is kept
     in `backups/<time>/` beside it. The folder brought over keeps its
     database as `copilot.db.adopted-<time>`; the others looked at keep
     theirs as `copilot.db.older-<time>` (if a rescue copy was used, the
     package's own database ends up `.older-`).
  6. If the relay stops with `[data] Not starting: each database has
     changes newer than the other's`, both hold work; the error line names
     both folders, and one may be under
     `rescued-package-data/<time>/data`. Pick the one to keep, and move
     the other one's `copilot.db`, `copilot.db-wal` and `copilot.db-shm`
     into a folder of your own (do not delete them). Then `oar start`
     again.
  7. If you already updated without saving and nothing was copied, the
     database from the package can't be recovered by OAR.
- The npm package guard allows 8 MiB unpacked and 530 entries (was 7.75
  MiB and 520); the take-over of earlier databases, the install-time copy
  and the lock checks grew the package to about 7.75 MiB and 521 entries.

### Added

- **Woken when the relay runs again** (`relay_restarted`, opt-in per
  conversation). A conversation that queued a relay restart, or watched
  sessions, slept after the restart until someone wrote, because the timers
  its CLI had scheduled might not survive it. An agent can now subscribe to
  `relay_restarted` through `remote_relay` (no sessions needed, no approval
  card, this relay only); after each start it gets one relay event with when
  the relay came back and how it stopped (who requested the restart, when
  and why, or that it did not record how it stopped). Never part of the
  default events. A restart requested while a turn it woke still runs does
  not wake that conversation (a one-shot subscription held back so ends),
  archived and deleted conversations are not woken, and each start is told
  once.

### Changed

- **Help texts and CLI messages say what the relay does.** **Accept prompts
  from other relays' agents** lists everything it refuses when off, watching
  sessions included; **Show Suspend host action** says it is a switch of this
  browser and suspend works on Windows relays only; the Cursor session token
  names the real usage bars; the Copilot engine applies whenever a
  conversation's worker starts. `oar` points to **Settings → General →
  Autostart (Windows)**, says the service starts again at boot with
  lingering, sends a failed start or restart through the service to
  `journalctl --user -u oar` instead of `server-err.log`, words a busy port
  one way, and says an already running relay keeps its version and settings
  until `oar restart`.
- **Agent guidance.** The ask_user example in the Copilot engines' relay
  guidance is a real question instead of quiz placeholders, the guidance and
  the Cursor and Copilot ask_user descriptions give the choice counts the
  relay accepts (it keeps the first 8), the remote relay section names every
  subscription action and `usage`, and the restart note says a queued
  restart waits for every running turn and holds new messages.
- **Docs brought in line with the code**: the paired-relay switch, watch
  approvals per relay, no push for agent-started turns, provider rebinding of
  unstarted chats, OpenAI key removal, `oar stop`/`oar restart` under the
  systemd service (they end running turns and workers), Claude turns on the
  bundled Claude Code, the config keys and environment variables, which
  variables reach workers started under tmux, the worker supervisor and the
  database migrations.
- **Uploads follow the config's `dataDir`.** It moved the database but
  left uploads in `server/uploads` unless `COPILOT_WEB_RELAY_DATA_DIR` was
  set; they now go to `<dataDir>/uploads` as well. Uploads earlier versions
  left in `server/uploads`, or that a state migration copied into the state
  root's `uploads/`, are still read from there in place: every attachment
  opens after the update, and nothing in those folders is moved or deleted.
- `@anthropic-ai/claude-agent-sdk` 0.3.304 (was 0.3.292; bundled Claude Code
  2.1.304). Claude now forks sub-agents that inherit the conversation
  (`subagent_type: "fork"`) by default. With thinking turned off, a model that
  cannot run without thinking now uses adaptive thinking. A full disk during a
  login refresh is reported as a failed request instead of a sign-in error.
  Fixes include an approved tool call that could run twice on resume, model
  switches and interrupts waiting behind a context-usage check, and
  `hook_progress` messages piling up in memory.
- `@cursor/sdk` 1.0.38 (was 1.0.36), which uses the relay's own `zod`
  instead of carrying a copy of zod 3.
- `@github/copilot-sdk` 1.0.23 (was 1.0.17; bundled Copilot CLI 1.0.100).
  The Copilot workers and the web-relay extension are unchanged: under the
  Copilot CLI both run the SDK that comes with the installed CLI. **About
  OAR** shows the new version.

### Fixed

- **Windows autostart starts the relay on the same data as `oar start`.**
  The sign-in entry and the system-startup launcher set only the config
  file, so a relay they started kept its database, uploads and log inside
  the installed package: other conversations and settings than with
  `oar start`, and gone with the next update. Both now also set the data
  and log folders `oar start` uses (`%APPDATA%\oar\data` and
  `%APPDATA%\oar\logs` on a global install). Once it runs, the relay brings
  an entry or launcher that an earlier version (0.9.0 on) generated for
  this install and its config up to date, the pre-rebrand
  `copilot-remote-web-relay.cmd` under its own name, so the first start
  after the update (by `oar start`, `oar update` or the autostart itself)
  repairs it. An entry edited by hand, one that points at another config
  file, and one of a relay started on data folders of its own are left
  alone: switch autostart off and on in Settings to replace those. Rewriting
  a launcher while the relay it started still runs is safe: its cmd window
  ends with the relay instead of starting it a second time. The launchers
  now switch cmd to UTF-8, so a user folder with non-ASCII characters in its
  name no longer garbles the paths in them. Conversations a relay started
  by autostart kept inside the package folder are not carried over.
- **A relay never moves to another database unannounced.** Before its own
  database opens, a global install's relay pinned to the OAR data folder
  looks once at each database it may have run on until now (the one inside
  the package, the install-time copies of it): a newer one is copied in
  after a `quick_check` of the copy, with the uploads and Cursor agent
  stores (never over a file there), the older one in place is kept in
  `backups/<time>/`, and one line says so. Each one looked at is renamed
  in place to `copilot.db.adopted-<time>` or `copilot.db.older-<time>`,
  never deleted. When neither is clearly newer, or a relay may still run
  on the other, the relay stops with one line naming both and exit code
  78, which its supervisors, and a systemd unit written by this version's
  `oar service install`, do not retry. The swap survives a kill. A global
  install always runs on the state root's data folder, however it is
  started; a `dataDir` in config.json that an earlier autostart relay used
  is copied from once and left exactly as it is. A git checkout and a
  relay on another state root are left alone. A first start that finds an earlier launcher
  but no database of it says the update may have removed it. A large
  database takes minutes: the relay logs its size at the start, progress
  at least once a minute and each step's time at the end, and `oar start`
  meanwhile says it is still bringing it over. A second `oar start` then
  no longer removes the relay's lock and starts a second relay.
- **A relay lock an unclean end left no longer blocks the next start.** A
  lock from before the last boot, or whose pid now belongs to a process
  started after it, is stale; a lock still held stops the start with one
  line naming it and exit code 78. A lock is never seen half written, and
  one that cannot be read is read again and held unless its time is more
  than 10 s off (an empty one a power loss left). Two starts recovering
  the same stale lock no longer both run.
- **A `TEMP` or `TMP` set with quotes, or naming a missing folder, is fixed
  for the relay** on Windows (quotes off, else the user's temp folder).
- **The relay a plain `gh copilot` starts keeps its data outside the
  package.** After `oar copilot` installed the Copilot CLI extension for
  every folder, a plain `gh copilot` ran its relay on `server/data` and
  `server/config.json` inside the installed package, on every platform. A
  global install's extension now starts it on the OAR state root's
  config, data and logs, as `oar start` does, and copies a config the
  package held there once. The database from the package is saved only
  where the install-time copy ran (see the upgrade note).
- **Windows autostart waits for a late drive.** Both the sign-in entry and
  the system-startup launcher now wait up to 5 minutes in all for the
  `%TEMP%` folder and the drive of the data folder (a RAM disk or a drive a
  startup script mounts later), where the system-startup launcher waited
  2 minutes for `%TEMP%` only and the sign-in entry not at all. A wait that
  runs out writes one line naming what is still missing, then starts the
  relay anyway: `oar-web-relay-launcher.log` beside the system-startup
  launcher, `oar-web-relay.log` in the OAR folder (`%APPDATA%\oar`) for the
  sign-in entry. A data folder on a network share is not waited for. The
  first start after the update brings a generated entry or launcher up to
  date without an admin confirmation; edited ones stay as they are. A relay
  whose data or upload folder cannot be created (its drive still missing, a
  file in its place) now stops with one line naming the folder and exit
  code 78 instead of an error trace. A `TEMP`
  set with quotes (`"D:\My Temp"`) no longer stops the system-startup
  launcher before it starts the relay.
- **Cursor conversations keep their agent across updates.** The Cursor
  worker kept its per-conversation agent stores in
  `server/data/cursor-agents` inside the installed package, so an update
  deleted them and a Cursor conversation went on with a new agent that knew
  nothing of the earlier turns. The stores now live in `cursor-agents` in
  the relay's data folder (`~/.oar/data` on a global install, unchanged
  `server/data` in a checkout); `CURSOR_AGENT_STORE_DIR` still overrides
  it. The copies the state migration made there are read again, as they
  were at the migration. A conversation with a store in both places uses
  the one changed last, and one with a store only at the old place keeps
  using it there; nothing is moved or deleted.
- **`oar setup --migrate-from` works after the installer has run.** The
  state migration wrote its marker even when it found nothing to bring
  over, and every later `--migrate-from <dir>` then did nothing without a
  word. The marker is now written only after a real copy, and a folder
  named with `--migrate-from` is always migrated, with a line saying what
  was copied or why nothing was. It still never overwrites: a `config.json`
  already in the state root is kept; the empty database the installer's
  relay created is moved into `backups/` (the relay has to be stopped
  first, `oar stop`), and a database with conversations makes it refuse
  with what to do instead.
  The same folder again only says it is already migrated, and a refused
  `oar copilot --migrate-from` warns and starts the session anyway. While
  the migration copies a database it holds the relay's lock, so no relay
  starts on it in between. Migrated uploads now land in `data/uploads`,
  where a global install's relay reads them (they went to an `uploads`
  folder nothing read); uploads an earlier migration left in
  `~/.oar/uploads` are merged into `data/uploads` at the next relay start
  (nothing is overwritten or deleted). A migration that fails its check
  removes only what it copied, no longer the whole state folder, and never
  a link or file that was there before; a database it moved aside and
  cannot put back stays in `backups/`. Symlinked folders in the checkout
  are copied as real folders.
- **An agent's preview tool reaches only its own conversation's previews.**
  The tool's `list` showed every live preview of the relay with its token,
  the only credential of a preview, and `close` closed any of them. `list`
  now shows the calling conversation's previews, and `close` of another
  conversation's preview is refused with a message saying so. Copilot and
  Grok sessions that use the HTTP API are taught the calls with their
  conversation written in. The relay enforces this for every preview
  request that names a conversation (the `conversationId` query or the
  worker's conversation header); the web UI's Settings › Previews and
  `/preview list` still show and close every preview. Agents present the
  same relay token as the owner, so an agent that calls the API by hand
  without naming a conversation still sees them all; see
  docs/preview-servers.md.
- **A conversation whose working directory is gone says so.** A Claude turn
  in a folder that had been deleted or renamed failed with "native binary …
  exists but failed to launch", blaming the system's libc; a Grok turn said
  the Grok CLI was not installed, a Copilot (SDK engine) turn showed the
  spawn's `ENOENT`. Claude, Copilot, Cursor and Grok workers now check the
  folder before they start their CLI or agent in it, and the turn fails with
  the folder's path and what to do: restore it, or choose another one with
  **⋯ → Change CWD**, then send the message again. A worker that cannot be
  started at all for that reason (a launch without tmux, as on Windows)
  names the folder in its launch note instead of a missing `node` or
  `cmd.exe`.
- **Answering a question no longer gets a long turn requeued by Max turn
  duration.** Answering one of a turn's questions restarts the max turn
  duration's clock, but only when the relay picked the turns to requeue; the
  requeue itself still counted from the turn's start and took every turn
  past it whenever another turn was due. Such a turn was sent again
  mid-answer, without the retry limit and without the page hearing of it.
  The relay now requeues exactly the turns it picked, by the same rule. The
  settings help and the docs now say where the limit counts from, and that
  Grok also enforces it itself, counted from the start of the prompt and
  without pausing for a remote relay approval card.
- **A resumed sub-agent shows its record and is listed while it runs.** When
  a Claude session sent a finished background agent a new message, the task
  panel showed it running, but opening it said "This agent's record could
  not be loaded", and the session's task list (`read_session`,
  `list_sessions`) did not list it at all: the relay took it for the
  agent's first run, which had ended. The resumed agent now
  opens its own record, which goes on where the first run ended (a note
  marks where it resumed) and reads running again until it ends; it is a
  running task of the session again, with a start and an end of its own.
- **Approval cards take a choice, not typed text, and every one reads it the
  same way.** OAR's own Allow / Deny cards (agent sessions, watching
  sessions, write actions in the ask and plan modes) and Claude Cloud's
  permission cards showed a reply box, and whatever was typed there ("yes",
  "ok", "allow it") counted as a denial; Claude Cloud even denied a typed
  "allow". These cards have no reply box now, the relay refuses typed text
  for any card that does not take it (the card stays open), and a choice
  counts however it is typed. A card created through the API with choices
  and no `allowFreeform` is such a card too (the flag defaults to `false`
  when choices are given). Copilot's permission card keeps its reply box,
  and now says that a typed reply refuses and tells Copilot why. A card's
  header (**Agent sessions**, **Relay events**, **Remote relay**, Claude's
  question headers) is shown above the question, and a question's push
  notification names the provider that asks instead of always saying
  "Copilot needs your input".
- **Reasoning effort reaches every Cursor model that takes one.** Cursor
  models whose effort parameter is named `reasoning_effort` (Claude Haiku 5.5,
  Claude Sonnet 5.5, Grok 4.7, Gemini 4 Argon, Gemini 3.8 Flash, Muse Wonder
  1.0) offered only None in the composer and could not be sent an effort.
  They now list their tiers once the Cursor models are discovered again
  (**Refresh** in **Select Models**, or saving the Cursor key), and the
  chosen effort is sent with the turn.

## [0.9.13] — 2026-10-20

Highlights: a queued relay restart now shows every page what it waits for,
which messages it holds and which background tasks keep running, and after a
time you set it asks instead of waiting forever; it never restarts by itself
while turns run, and can tell the sessions a restart cut off to carry on
(opt-in). The task console survives a relay restart, marks where a `| tail`
holds output back, keeps the task's row in view, and counts a test run over
its whole log. A message
sent without a model keeps the conversation's model, effort and mode,
`remote_relay` refuses a model the provider does not list, watching agents
are no longer woken by every finished shell command, workers reconnect after
a hung restart, and the unit suite passes on Windows again.

### Upgrade notes

- Migration 0018 (the table `background_task_rows`) runs by itself on the
  first start. Rows the runtime before this update held in memory are lost
  one last time at the restart into it. The Node.js requirement is unchanged
  (22.13 or newer).
- New settings in **Settings › General**: **Ask after a queued relay restart
  has waited** (30 minutes by default) and **After a relay restart, tell
  interrupted sessions to carry on** (off by default); a new push event,
  **Queued relay restart waited its maximum time** (Settings › Notifications),
  is on by default.
- **Watching agents:** a subscription that named no events now leaves out
  successful shell commands (sub-agent ends and failures still wake it); one
  that named its events keeps them. Name `task_finished` to get every task end.
- **Scripts that post `/api/message` without a model** to an existing
  conversation now get the conversation's own model, effort and mode, or a
  `409 CONVERSATION_MODEL_UNAVAILABLE` when that model left the catalog,
  instead of the relay's first model.
- The npm package guard allows 7.75 MiB unpacked and 520 entries (was 7.5
  MiB and 510); the restart queue, the stored task rows and the restart note
  grew the server and the app to about 7.57 MiB and 514 entries.

### Added

- **After a relay restart, tell interrupted sessions to carry on** (Settings
  › General, off by default, a setting of the relay). A turn a restart cut
  off for good (the agent had already taken the message, so it cannot run
  again) used to stop without the agent ever hearing of it. With the setting
  on, its session gets one compact **relay** note once the relay is back:
  when the relay restarted, and to check what it was doing and carry on.
  The user's message is never sent again, and nothing goes to idle sessions,
  to turns the relay requeues (they run again by themselves), to archived
  conversations or while a usage-limit pause holds the session; a message
  queued meanwhile goes first.
- **The task console marks where a `| tail` holds the output back.** A
  command piped into `tail` (`npm test 2>&1 | tail -40`) writes nothing
  until it ends, so its console looked stuck. When the task's command line
  shows such a pipe (`tail -f` and `head` pass lines on and are left
  alone), the console marks where the output stops, with a hint to log to a
  file instead, until more output comes or the task ends; the row's quiet
  hint says the same on hover. The Claude, Copilot and Grok workers now report a
  shell task's command line on its row (scrubbed of credentials by the relay
  and cut at 2,000 characters; `read_session` passes it on).
- **Load earlier in the console's header.** It sat only above the first
  line, out of reach while following the end of a long log; the header now
  has it too whenever there is earlier output.

- **A queued relay restart shows what it waits for, and asks instead of
  waiting forever.** **🌄 Restart web relay** first lists the sessions with
  a running turn it would wait for, the messages it would hold, and the
  sessions with background tasks (commands, monitors, sub-agents), each with
  whether it keeps running; **Restart when idle** queues the restart,
  **Restart now** does not wait. While a restart is queued every page shows a
  banner: *Relay restart queued — waiting for N sessions*, the sessions as
  links, how long it has waited, that new messages are held until then, the
  background tasks, and **Restart now** (it asks first and names the
  sessions it does not wait for) and **Cancel restart**. A new setting,
  **Ask after a queued relay restart has waited** (Settings › General,
  30 minutes by default, 5 minutes to 4 hours or no limit), bounds the wait:
  after it the banner asks *restart now, keep waiting or cancel?* and a push
  notification (a new event, on by default) asks the same. It never
  restarts while the turns run, and still restarts as soon as they end;
  **Keep waiting** waits another period.
  `POST /api/relay/shutdown` answers with the same picture (`waitingFor`,
  `held`, `backgroundTasks` with `survives`), so an agent that requests a
  restart can tell the user, and takes `immediate: true`; `GET
  /api/relay/shutdown` and `POST /api/relay/shutdown/keep-waiting` are new.

### Changed

- **The open console leaves the task's row in view.** On a screen wider
  than a phone the console now ends above the task's row in the composer
  panel, so the row's ✓/✘ chip, clock and **Stop** stay visible and live
  beside it; on a phone it stays full-screen, with the same chip in its
  header.
- **One wording for a task without output.** The row's hover title said
  "output not available for this provider" and the console "Output is not
  available for this provider."; both now use the sentence, from the same
  text the relay answers with.
- **A watching agent is no longer woken for every shell command that ended
  well.** A relay event subscription that names no `events` now gets
  `subagent_finished` instead of `task_finished`: a background sub-agent that
  finished still wakes the watcher, and so does any task that failed or
  exited non-zero (`task_failed`), but a shell command that ended well does
  not. A busy worker ends one every minute or so, and each was a turn of the
  watcher on its whole context (35 during one 20-minute wait were seen).
  Name `task_finished` in `events` to get every task end, as before.
  Existing subscriptions that named no events switch to the new default by
  themselves; those that named their events keep them. A paired relay on an
  older OAR applies its own default and refuses `subagent_finished` by name.

### Fixed

- **A message sent without a model keeps the conversation's model and
  effort.** A message to an existing Copilot conversation that named no model
  (sent by a script or an agent, not by the composer) ran on the first model
  of the catalog with effort `none`, which some models refuse, and then saved
  that model and effort as the conversation's own, so the composer showed
  them from then on. Such a message now runs on the conversation's model and
  effort, and saves nothing it did not name. If the conversation's model has
  left the catalog, the send is refused with a message saying so instead of
  switching to another model. OpenAI, Claude, Cursor and Grok conversations
  keep their effort the same way, and so does the follow-up of a plan
  board's action. A message that names no mode runs in the conversation's
  mode instead of agent mode, and no longer switches a plan-mode
  conversation to agent. A message whose turn failed can be sent again at
  once: it no longer counts as a duplicate of itself.
- **Test counts of a long run no longer drop out.** The relay counted a
  test run from the last 64 KB of its output only, so a live run that wrote
  more lost its runner's first line: the chip disappeared or undercounted.
  A run still going is now counted over its whole log, read on as it grows
  (and read again in bounded steps after a relay restart); the closing
  summary still decides once it is there.
- **Credentials in background-task rows are blanked.** A task's
  description, summary and last tool call went to the pages, `read_session`
  and the stored console rows as the worker sent them, and a Grok terminal's
  (or a Copilot shell's) description is its command line. The relay now
  scrubs them like the console output. The scrubber also catches `curl -u
  name:password` (also attached), `--password`/`--token`/`--secret`
  values, `mysql -p…`, `docker login -p`, `sshpass -p`, `redis-cli -a`,
  `aws_secret_access_key` in a file or `aws configure set`, Slack webhook
  paths, `?key=`/`&sig=`/`&token=` query values and an `Authorization`
  header in any case and with any scheme word, and leaves a reference such
  as `$(cat ~/.token)` or `$API_TOKEN` alone.
- **Inverse text in the task console.** vitest's RUN, PASS and FAIL badges
  (SGR 7) showed as plain words; inverse text now swaps its colours, so
  they show filled.
- **The task console survives a relay restart.** Its rows lived in the
  relay's memory: after a restart a running command came back to the panel
  once its worker reported, but the dimmed rows of commands that had
  finished within the hour were gone, and a console open at the time said
  the output was no longer available. The rows are now kept in the database
  (migration 0018): finished rows come back with their ✓ or ✘ for the rest
  of their hour, and a running command's console reads its output at once.
  Such a command is shown as running again only when its worker says so
  (until then its console says it waits for the worker, without **Stop**);
  one whose worker did not survive the restart is marked finished with an
  unknown result (a neutral ? instead of ✓ or ✘) after about a minute and a
  half, its output still readable.
- **A scroll right after older messages load is no longer undone.** The page
  put the reader back where they were when the older page arrived, a frame
  later: scrolling in that frame (up again after the jump-to-bottom button,
  for instance) was reverted, and could leave you at the end, following new
  rows you meant to read later.
- **The jump-to-bottom badge counts a message that arrives just as you scroll
  up.** One that landed before the page had noted the scroll, a frame and on
  a busy page up to a tenth of a second, was taken as already seen.
- **The background-task panel no longer shrinks back for a moment.** While
  the agent works the page re-reads the conversation, and an answer read
  before the panel grew put the smaller set of tasks back until the next
  read. The panel jumped, and a reader following the newest messages could be
  left above them.
- **A worker reconnects after a relay restart even when its connect hangs.**
  A worker's link to the relay was retried only once the socket reported an
  error or a close. A connect that never finished, a socket the relay
  accepted but never greeted, or a close that never completed while the
  relay hung in its shutdown left the worker without a connection and
  without a next attempt, and messages to its session stayed queued; the
  relay's replacement of such a worker does not step in while the session
  is working. The link now gives up a socket that has not completed its
  handshake within 15 seconds, does not wait for a close after the relay
  says it is shutting down, and retries a socket that fails to construct.
  There is always exactly one next attempt, with the usual backoff of up to
  8 seconds, which now starts over only after a completed handshake. Failed
  attempts log one line each in the worker log, at most one a minute after
  the first three.
- **`remote_relay` refuses a model the provider does not list.**
  `create_session` passed any model id on, so a Copilot id written with a
  hyphen ("gpt-5-4" for "gpt-5.4") created a session on another model, which
  every later `send` with that id failed to reach. A model in
  `create_session` or `send` is now checked against the list New Chat offers
  for the provider on the target relay, before any approval card: an unknown
  one is refused with the close matches and the valid ids ("Unknown model
  'gpt-5-4' for Copilot on relay …; did you mean 'gpt-5.4'?"), and nothing is created
  or sent. Claude also takes `opus`, `sonnet` and `haiku` (the newest listed
  model of that name), and a Copilot id with its effort (`gpt-5.4-high`) runs
  as that model with that effort. When the relay has no list for the provider yet, the
  model goes on unchecked and the answer says so. A relay also refuses an
  unknown Copilot model when another relay's agent starts a session on it.
- **A preview's websocket is dropped when the browser hangs up before the dev
  server answers.** A browser that closed its connection with a plain FIN
  while the upgrade was still waiting on the dev server left both sides
  open, even when a reset followed: the request
  to the dev server stayed pending, and the preview lane could not stop
  until the dev server answered. Both sides are now dropped, and stopping
  the lane also drops upgrades still waiting on the dev server.
- **The unit test suite passes and finishes on Windows again.** A preview
  test waited forever for a websocket hang-up (fixed in the product, above),
  and several tests expected bare program names or Unix paths where Windows
  resolves the full path of its own tools; two unlocks recorded in the same
  millisecond are now listed in the order they were recorded.

## [0.9.12] — 2026-10-18

Highlights: a background command or monitor in the task panel opens a
console with its output, live, in colour and with secrets blanked, paging
back through the whole log and with its own **Stop**. Task rows say when a
task has gone quiet ("no output for 12 min", amber after a time you set in
Settings) and show a **✓ 412 ✘ 2** chip when the output is a test run;
sub-agent rows count their steps, and agents read a task's output on a
paired relay with `remote_relay` `read_task_output`. Long conversations open
and page back fast, and switching away and back, or reloading, returns to
the message you were reading, older pages included; new messages wait below
a place far up the history instead of skipping the ones in between.

### Upgrade notes

- Migration 0017 (two indexes for the history of long conversations) runs by
  itself on the first start. The Node.js requirement is unchanged (22.13 or
  newer), and no setting or config key needs changing.
- Two new settings in **Settings › General**: **Mark a background task as
  quiet after** (10 minutes by default, for the relay) and **Messages kept
  per conversation for switching back** (200 by default, per browser).
- **Claude background commands may run for 2 hours** before Claude Code
  stops them, and up to 8 hours when Claude asks; **Settings › Providers ›
  Claude** sets the limit. OAR now sets `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS` and
  `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS` for the Claude sessions it starts,
  so values of these in the relay's environment no longer apply. Commands
  that start with `sleep`, and sub-agents' commands, are not moved to the
  background after 2 minutes and may block a turn up to the limit.

### Added

- **Click a background command to watch its output.** A backgrounded shell
  command or monitor in the composer's task panel opens a console: the last
  2,000 lines, following live, with **Load earlier** paging back through the
  whole log (about 5 MB at most). Progress-bar redraws collapse to their last
  state, repeated lines fold into one with ×N, colours are kept and other
  control codes dropped, secrets are blanked, and the console has its own
  **Stop**. A finished command keeps a dimmed ✓/✘ row for an hour so a failed
  run can still be read. Claude reads the file its CLI writes for the command,
  Copilot a detached shell's log or an attached shell's recent output, and
  Grok now lists its terminals as tasks. A session started before this
  release names no output file; its console says so and that a restart of
  the session helps.
- **Task rows say when a task has gone quiet** ("no output for 12 min", amber
  after **Settings › General › Mark a background task as quiet after**, 10
  minutes by default) and show a **✓ 412 ✘ 2** chip when the output is a
  vitest, Playwright, node:test, jest, pytest or turbo run (also through
  pnpm); the console header's chip jumps to the first failure, and a run
  that ends shows its final counts within a moment.
- **Sub-agent rows in the task panel show their step count** ("22 steps"), as
  the rows in the reply already did.
- **Settings › Providers › Claude › Claude background command limit** (30
  minutes to 8 hours, 2 hours by default) sets how long a command Claude runs
  in the background may take before Claude Code stops it, when Claude gives it
  no timeout of its own; Claude may still ask for up to 8 hours for one
  command. A foreground command moves to the background after 2 minutes, so
  the turn goes on while it runs. Claude is also told to write the output of
  long runs to a log file instead of piping it into `tail`, and to start runs
  that must survive a session restart with `nohup`. A change applies to Claude
  sessions started afterwards; Claude Cloud is not affected.
- **`remote_relay` action `read_task_output`** gives agents the same tail,
  quiet time and counts of a task on a relay they may read; `read_session`
  lists the task ids with that health.

### Changed

- **Long conversations open and scroll back fast.** A history page used to
  load and prepare every message of the conversation, so a chat with a few
  thousand messages took about two seconds per page and per live refresh. The
  relay now reads only the requested page from the database (migration 0017
  adds the indexes for it), so a page loads in well under a tenth of a second
  however long the conversation is.
- Switching back to a conversation already viewed in this tab draws it at
  once from what the page kept of it; the relay's fresh answer is merged into
  it when it arrives.
- **Settings › General › Messages kept per conversation for switching back**
  (200 by default, 100 to 1,000 or no limit, saved in this browser) sets how
  many loaded messages each of the last eight conversations keeps.
- **The conversation list shows activity by the title's colour.** The three
  animated dots after a working session's title are gone: a ready session
  that runs a turn or background work keeps the bright green title, an idle
  one turns a darker green (a muted green in the light theme), and the chat
  header follows the same rule. Question, error, offline and archived titles
  keep their colours.
- The npm package guard allows 7.5 MiB unpacked and 510 entries (was 7.25
  MiB and 490); the task console, the transcript's handling of new
  messages below a place far up the history, the Copilot task report and the
  Claude background command limit grew the server and the app to about 7.37
  MiB and 505 entries.

### Fixed

- **Copilot background tasks report how they ended.** Finished shells and
  sub-agents of Copilot's SDK engine showed the status *unknown* and no exit
  code, in the task data agents read and wherever the end is shown. The
  worker now reports completed, failed or cancelled, a shell's exit code, and
  a sub-agent's result (or its error) as its summary; a passing status line
  such as *Thinking…* is no longer kept as the final summary.
- **Cancel on a usage-limit pause removes the relay's held follow-up from the
  open conversation at once.** The *Automatic message from OAR* row was
  deleted on the relay but stayed on the page, and in what the page kept for
  switching back, until a reload. A row deleted while you were elsewhere
  leaves too, also when it was the conversation's newest.

- **Switching away from a long conversation and back keeps your place.** After
  loading older messages and scrolling back into them, a switch to another
  conversation and back lost the reading position: with more than 100 messages
  loaded the oldest were dropped, and messages written meanwhile moved the view
  by as many rows. The page now remembers the message you were reading and
  keeps the loaded messages, so you come back to the same message at the same
  place, older pages included; after a reload it opens at that message too.
- **New messages no longer skip the ones in between while you read far up.**
  Opened at a pin, a search result or the place you were reading after a
  reload, a conversation shows the messages around it. A message or reply that
  arrived then was put right under them, and the messages between were never
  loaded when you scrolled down, only the jump-to-bottom button brought them.
  Now new messages wait: the button counts them, and scrolling down loads
  every message in between, in order, before them. A reply still being
  written shows once you are there. A message you send from there takes you
  to the end, where it, its reply and everything in between show.
- **Images that load late no longer push the message you are reading down.**
  In a browser without scroll anchoring (Safari, for one), pictures above
  your place that arrived after a switch back, a reload or an older page moved
  the text by their height. The transcript now holds your place while they
  load, and lets go as soon as you scroll.

## [0.9.11] — 2026-10-17

Highlights: sessions an agent starts now sit in a group under the session
that started it, with a pill that sums up what runs and what waits for you,
and rows drag into, out of and within a group. Settings › Sharing lists every
shared link with Copy, Renew and Stop and an access log of each open (the IP
address optional), shared views hide the host's paths in one of three modes,
**Preview as shared** shows what a viewer gets, and a 🙈 list gathers the
messages hidden from viewers. The relay is harder to reach from outside: ten
wrong tokens lock an address out for a minute, the live channel accepts only
the relay's own origin, forwarded headers count only from a trusted proxy, and
`?token=` signs in the page only. Day/Night is back in the ⋯ menu, next to the
new **About OAR**.

### Upgrade notes

- **Behind a reverse proxy on another host or origin, set `trustProxy` and
  `allowedOrigins`.** This is the first release that checks the origin of the
  live Socket.IO channel and that reads the client address, host and scheme
  from `X-Forwarded-*` headers only when the proxy is trusted. A proxy on the
  relay host itself is trusted already (`trustProxy` defaults to
  `"loopback"`). For one on another machine, or one that rewrites the `Host`
  header, add to the config file (`~/.oar/config.json`, or `server/config.json`
  in a git checkout) and restart the relay:

  ```json
  "trustProxy": "192.0.2.10",
  "allowedOrigins": ["https://relay.example.com"]
  ```

  `trustProxy` takes what Express's `trust proxy` takes: the proxy's address,
  a subnet such as `"10.0.0.0/8"`, or a hop count such as `1`.
  `allowedOrigins` lists the public origins exactly as the browser shows them
  (scheme, host, a port other than the default). Without them, the page loads
  but its live connection is refused (the relay logs `Refused a handshake from
  origin …`), and every client shares the proxy's address, so one client's
  ten wrong tokens lock the rest out for a minute.
- **Ten wrong tokens from one address within a minute answer `429`** with
  `Retry-After` until the minute is over. Requests from the relay host itself
  that no proxy forwarded are never counted.
- **`?token=` works on the page address only.** Scripts that fetch API, file
  or asset URLs with `?token=` must send `Authorization: Bearer <token>`
  instead (or the cookie); a Socket.IO client passes it as `auth.token` (or
  the cookie), not in the query.
- **Restart web relay, cancelling a queued restart and Empty queue need only
  the token**, from any signed-in device. The session-worker socket and the
  image-operation run answer only requests from the relay host that no tunnel
  or proxy forwarded.
- Four database migrations (0013 previews, 0014 session groups, 0015 the place
  in a group, 0016 the share access log) run by themselves on the first
  start. The Node.js requirement is unchanged (22.13 or newer).

### Added

- **Session groups in the sidebar.** A session that an agent starts with the
  `remote_relay` tool now sits under the session that started it. The head
  row carries a fold button and a pill that sums up the members ("3 · 1 waiting
  for you, 2 running"); the members are indented under it, folded away once
  everything in the group has finished unless you fold or unfold it yourself.
  A question or approval waiting in a folded member shows on the head row,
  and a tap on it opens that member. A member's activity lifts the whole
  group to the top of the list. The head row's menu archives the whole group
  (members still working are kept and named) and stops everything running in
  it, and dissolves it; any row's menu adds a conversation to a group,
  moves it, or takes it out, and groups can be named by hand. The `remote_relay` tool's
  `list_sessions` and `read_session` show the group a session is in (agents
  only read it). Migration 0014 adds the `conversation_groups` table and the
  `group_id` column; nothing is backfilled.
- **Drag and drop for session groups.** Drag a session into a group, out of
  it, or to another place inside it; the order you set stays, and later
  arrivals join at the end. Drop one loose session onto the middle of another
  and the two make a new group. On a phone a long press lifts the row and a
  move drags it; with the keyboard, a member's menu has "Move up" and "Move
  down". Migration 0015 adds the `group_position` column. Rolling back needs
  no data change: older releases ignore the column, and a stale place they
  leave behind is cleared when this release starts again.
- **A 🙈 list of the messages hidden from shared viewers.** Next to 📍, a 🙈
  button with a count appears while the open conversation hides messages
  from its shared link (never in the shared view itself). It opens a list
  like the pinned one: each row jumps to its message, also one far up in the
  history, and has Unhide; "Unhide all" asks first and leaves only a message
  whose turn is still running hidden, naming it. The count and the list cover
  messages outside the loaded page, and other open tabs and devices follow a
  change without a reload.
- **Manage your shared links in Settings › Sharing.** Every shared
  conversation is listed with when it was shared and last opened, how often
  and by how many viewers. **Copy link** copies it, **Renew link** gives the
  conversation a new link (the old one stops working at once), and **Stop
  sharing** ends it; the `⋯` menu has **Stop sharing** too while the open
  conversation is shared, and asks first. Each row unfolds into an access
  log: one entry per open of the page (not per refresh) with time, IP
  address, country and browser. The log carries over to a renewed link and
  is deleted when you stop sharing or delete the conversation. Switch off
  **Store viewer IP addresses** to log new opens without the address (the
  status log of shared reads follows it); switching it off also offers to
  remove the addresses already stored, from both logs. Distinct viewers are
  still told apart. Migration 0016 adds the share lineage and the
  `conversation_share_opens` table.
- **Preview as shared.** The `⋯` menu's new entry opens the conversation as
  a share link shows it, without creating one: what viewers get instead of a
  path is marked green, whatever still looks like a path amber.
- **Sub-agent records in shared views.** A sub-agent's row in a shared
  conversation now opens its record, read-only and without Stop, filtered
  like the rest of the share.

- **Wrong tokens lock an address out for a minute.** Ten wrong tokens from
  one address within a minute (a Bearer header, the cookie, the sign-in field
  or a Socket.IO handshake) make the relay answer that address `429` with
  `Retry-After` until the minute is over, the right token included, and the
  sign-in page says how long to wait. The same stale value repeated counts
  once, so a tab with an old cookie does not lock you out. Requests from the
  relay host itself that no proxy forwarded are never locked out, so the
  relay's own workers and agent tools keep working.
- **About OAR in the ⋯ menu.** A new entry, "ℹ️ About OAR · <version>",
  opens what this relay is and has done: version, commit (for a git
  checkout) and when the relay started; each provider that is on, with its
  CLI and SDK version and whether it is online; conversations, turns and
  messages since the first conversation, turns per provider, and the usage
  the providers report (Copilot premium requests, Cursor and Grok tokens and
  cost, Claude Cloud cost); uptime, database size and running workers. With
  the opt-in update check on it names the latest version, otherwise it says
  where to turn the check on. Shared viewers do not get the entry. The data
  comes from the new `GET /api/about`, which counts large databases in small
  steps and keeps the totals for a minute.

### Changed

- **A stopped or renewed share link answers a plain 404**, the page included,
  exactly like a link that never existed, and a shared page that is still open
  stops at its next refresh instead of polling on. The address in the access
  log and in the status log of shared reads is now the one the relay trusts
  through its `trustProxy` setting; a forwarded header from an untrusted peer
  no longer sets it.

- **A share link no longer carries the relay host's paths.** The relay
  filters what it serves to shared viewers, by **Paths and file names** in
  Settings › Sharing: show every path, hide the path and keep the file name
  (the default), or hide both. Tool lines, thoughts, replies, attachments and sub-agent records all
  pass through it; before, only the viewer's browser shortened the paths in
  tool lines, and attachments carried their full path on the host. Free text
  is filtered on a best-effort basis: relative paths are left as they are.

- **A long press on a sidebar row opens its menu when the finger lifts**, no
  longer while it is still down: a long press that then moves drags the row
  instead. Where rows cannot move (the Archived view, under a filter, on a
  group's own line) the menu still opens during the press.

- **A reply to another agent's note is no longer folded away.** Only the
  note itself folds into its row now, "note from linux-test · report builder ·
  answered below"; the session's reply to it always shows, like a reply to
  you, because it may hold a line for you. A turn you steered a message into
  folds its note too, since nothing of yours is behind the row any more. The
  ⌄ button's badge counts the note and the reply as two rows.

- **A conversation no longer scrolls down by itself while you read further
  up.** It only moves when you are at its end, or when you have just sent a
  message yourself. Anywhere else it stays exactly where it is, whatever
  lands: a reply, a relay event, another agent's note, a question, an approval
  or a plan board. The ⌄ button then tells you: it turns blue with a count
  (or a dot while a reply is still being written) when something new is
  below, and amber with a "?" when a question or an approval waits for your
  answer; a screen reader hears both. The text you are reading also keeps its
  place when the reply you are in the middle of is finished and when the
  conversation reloads. New in Settings › General: "Jump to the end when I
  send a message", on by default and saved in the browser; switch it off and
  your own messages leave you where you are as well.

- The npm package guard allows 7.25 MiB unpacked and 490 entries (was 6.75
  MiB and 450); session groups, the stored previews, the background-task
  resync, the transcript anchor, share management, path privacy in shared
  views and About OAR grew the server and the app to about 7.05 MiB and 485
  entries.

- **Restart web relay, cancelling a queued restart and Empty queue work from
  every signed-in device.** They were meant for the relay host only, but the
  check let everything through a tunnel or a proxy on the same machine and
  refused only a direct LAN connection; they now need the token and nothing
  else. The other way round, the session-worker socket and the image-operation
  run now answer only requests from the relay host itself: a loopback peer
  with no `cf-ray` or other tunnel marker and no `X-Forwarded-For`,
  `Forwarded` or `X-Real-IP`. A same-host proxy that adds no marker no longer
  reaches them.

- **A `?token=` signs in the page only.** The page takes it out of the address
  and signs in with it as before; API, file and asset URLs now accept the
  token in the `Authorization` header or the cookie only, and a Socket.IO
  handshake no longer reads a `token` query.

- **The live Socket.IO channel accepts the relay's own origin only** (it
  accepted any). The host compared is the one the browser addressed,
  `X-Forwarded-Host` included when a trusted proxy sends it; for a proxy that
  rewrites the `Host` header, list the public origin in the new
  `allowedOrigins` setting.

### Fixed

- **Day/Night is back in the ⋯ menu.** Since 0.9.10 the entry showed only in
  a shared view; everywhere else, on every screen size, it was gone from the
  menu. It is there again whenever you are signed in, with or without a
  conversation open, and stays the one entry of a shared view.

- **A shared conversation no longer marks every reply "ran on" its own
  provider.** In a shared link to a Claude, Cursor, Grok or OpenAI
  conversation, each reply carried the red `ran on claude` (etc.) chip, as if
  the turn had run on the wrong provider. The shared view now knows which
  provider the conversation is bound to, and shows the chip only when a reply
  really ran on another one; with no provider bound it shows none.

- **A wide table in the file reader scrolls sideways.** A markdown table wider
  than the reader made the whole page scroll sideways, and a sideways swipe to
  read the rest of it turned to the next file instead. The table now scrolls
  in its own box, as code blocks do; a swipe that starts on it stays in the
  file.

- **A worker no longer stops reconnecting after a relay restart.** On Node
  22, a worker whose reconnect reached a relay that was not ready yet gave up
  for good: its process kept running without a connection, the relay started
  no new one while that process lived, and every message to the session
  stayed queued until the worker was killed and launched by hand. A failed
  connect now always leads to the next attempt, with the usual backoff of up
  to 8 seconds. As a safety net, the relay replaces a worker that has had no
  connection for 60 seconds while a message waits for it: it stops the old
  process and starts a new one, which then takes the message. It never does
  so while a turn or background work of that session is running, and logs a
  `WORKER DETACHED` line when it does.

- **A relay restart no longer forgets running background tasks.** A session
  with a background shell or sub-agent still running read as idle after the
  relay restarted: its task panel was empty, **Suspend host** saw nothing
  to wait for, and a watching session could be told `all_idle`. The relay
  now asks each worker for its tasks again on the worker's next heartbeat,
  and the tasks come back with their original start time. A session whose
  worker was started before this update shows "background work, details not
  reported since the relay restarted" until it reports. For the first 45
  seconds after a relay start a suspend waits for sessions that are still
  reporting, and a task that ended while the relay was away still reports
  its end.

- **Workers start when no `node` is on the relay's PATH.** A relay started
  by the Windows system-startup task, before anyone signed in, ran fine, but
  none of its workers ever started: they were launched with a bare `node`
  that the task's PATH did not have, Windows reported the failure in a
  dialog no one could see, and the log showed only a heartbeat timeout
  every 90 seconds. Workers now run on the relay's own Node by its full path
  on every platform, tmux included; `COPILOT_WEB_RELAY_NODE` still overrides
  it. That Node's folder is added at the end of a worker's PATH when the PATH
  lacks it, so the CLIs and commands a worker starts find a `node` too; a
  PATH that has one keeps it.

- **A worker that cannot be started says why.** On Windows, a launch whose
  `start` command fails or never returns now fails at once, naming the
  program, and the conversation's launch note shows it; before, the relay
  waited for a heartbeat that never came. The relay log names the command
  and the PATH, SystemRoot and ComSpec it was started with, also when a
  launch saw no worker process yet, and a failed process-list read logs its
  exit code and error output. Windows' own programs (PowerShell, schtasks,
  taskkill and others) are called by their full path. Changing the launch
  folder and the Windows autostart setting show the relay's reason when they
  fail, not a bare "Failed to …", and an autostart read that fails is logged.

- **The Windows system-startup launcher copes with an early boot.** The
  launcher OAR generates adds Node's folder at the end of PATH and waits up
  to two minutes for the `%TEMP%` folder to exist before it starts the relay
  (a temp folder on a drive that a startup script creates later no longer
  makes the relay and its CLIs fail); a wait that runs out is logged next to
  the launcher. Settings now names how a boot task or launcher differs from
  the generated one (a missing boot delay, an edited launcher) instead of
  treating it as a failure; selecting "At system startup" again regenerates
  both and keeps a changed launcher as a `.bak` copy. A boot task that cannot
  be read no longer breaks the setting.

- **Preview links survive a relay restart.** A preview lived only in the
  relay's memory, so an update, a queued restart or a crash turned every
  preview link into a 404, and publishing again gave a new link. Previews are
  now kept in the relay's database and restored when it starts, each checked
  again: a folder preview while its folder is still inside the workspace root,
  a dev-server preview until the machine reboots (on Windows with fast
  startup, until a Restart: Shut down and power-on is not seen as one).
  Publishing the same port or folder again in a conversation returns the same
  link. Deleting a conversation, also through a cache rebuild, closes its
  previews; archiving keeps them. Settings → Previews shows when each preview
  was published and last opened, and the limit of 8 names the oldest ones and
  how to close them. Relay logs no longer carry a preview's token; a publicly
  shared transcript shows a preview card with its label only and removes every
  preview link quoted in its text, also one cut short by a reply still being
  written. A preview the relay cannot check at a start (a busy database, an
  unreadable folder) is not served, shows as such in Settings, and is checked
  again every 15 s for ten minutes. The table comes with migration 0013, which
  runs by itself on the first start; the npm package gains two modules for it.

- **An install gets the dependency versions the release was tested with.**
  The package asked for each of its dependencies "this version or newer", so
  an install or update fetched whatever was newest that day, e.g. a newer
  Copilot SDK than any release was tested with. The packages OAR depends on
  directly (the Claude, Copilot and Cursor SDKs among them) are now pinned to
  exact versions; a newer one arrives with an OAR update. Packages those
  depend on still follow their own version ranges.

- **Restart web relay no longer reports success when the relay refuses it.**
  A refused request said "Relay restart requested"; it now shows the relay's
  reason, and a request that got no answer says so instead of claiming
  success. The restart after a feature-flag change and cancelling a queued
  restart report their errors the same way, and Empty queue names the reason
  it failed.

- **Forwarded headers count only from a trusted proxy everywhere.** The
  shared-view presence limit read `X-Forwarded-For` and `X-Real-IP` and the
  share links read `X-Forwarded-Host` and `X-Forwarded-Proto` straight from the
  request, so a direct client could pick its own rate-limit bucket or the
  host of a new share link. Both now follow the `trustProxy` setting.

- **`tunnelMarkerHeaders: []` in the config no longer switches off
  `COPILOT_TUNNEL_MARKER_HEADERS`.** The two lists are merged, with `cf-ray`
  always included.

## [0.9.10] — 2026-10-12

Highlights: sessions watch other sessions. An agent subscribes to sessions on
its own relay or on a paired one and is woken by what happens there:
questions waiting for an answer, errors, replies, finished background work,
sessions gone quiet. A subscription only notifies; it approves nothing, and
the first one in a conversation asks you on a card. Also new: a sub-agent's
whole record opens in a viewer, a note between agents and its reply fold into
one row, `remote_relay` reports what the provider plans have left, the file
browser creates, renames and deletes folders and files, a ⌄ button jumps back
to the latest message, archiving an active session asks first, and Settings
opens with no conversation open.

### Upgrade notes

- **Running sessions pick up the new tools when their worker restarts.** A
  session worker builds its `remote_relay` tool when it starts, so a worker
  that was already running before the update offers neither `subscribe` nor
  `usage`, and records no sub-agent timeline, until it is restarted: **☠️
  Kill session** on an idle session is enough, the next message starts a new
  worker. The database migrations run by themselves on the first start.

### Added

- **A session can watch other sessions and be woken by what happens there.**
  With `remote_relay`'s new `subscribe` an agent asks to be told about
  questions waiting for an answer, errors (a failed turn, the usage limit, a
  worker that died), replies, background agents and shell tasks that finish
  or fail, sessions that went quiet while working, and the moment nothing
  runs any more, for listed sessions or all of them. OAR writes a short event
  message into the watcher's conversation: a new turn when it is idle, a
  steer into the running turn where the provider steers, the next turn
  otherwise. The message says it is automated and approves nothing, and shows
  as a compact row, never as one of your messages. Events within 30 s come
  together; past 20 wake-ups an hour the rest comes as a digest every ten
  minutes, while questions and errors still come at once. An optional
  heartbeat says the watching works while anything runs. Subscriptions
  survive a restart and end on unsubscribe, when the watcher or the watched
  session is archived, or after firing once. The first subscribe of a
  conversation, and any to all sessions, asks you on an approval card;
  `transfer_subscriptions` hands every subscription of an old watcher to a
  new one after your approval. The watcher's header shows **watching N
  sessions** with an Unsubscribe button per subscription, and a watched
  session shows a **watched** badge.

- **Watch sessions on a paired relay.** `subscribe`, `unsubscribe`,
  `list_subscriptions` and `transfer_subscriptions` also take a paired
  relay, with the same events and options. The relay must be unlocked in
  the conversation and allow at least reading, and the other relay must
  accept other relays' agents; the approval card names that relay, and
  nothing is asked there. This relay fetches the events every few seconds
  over the pairing (a pairing in one direction is enough), and they arrive
  like those of its own sessions, their lines starting with the relay's
  name. If the link drops, the other relay keeps what happens (up to 500
  events per subscription, for 7 days) and delivers it as one row tagged
  **replayed** once it answers again, questions and errors first, between
  "link lost" and "link restored". Subscriptions survive restarts of either
  relay and end on unsubscribe (reaching the other relay later if it was
  offline), when the watcher or the watched session is archived, or when
  the pairing is removed. An older relay answers that it needs an update.

- **list_sessions and read_session say what a session is doing.** `state`
  is `running_turn`, `background_only` or `idle`, and `tasks` lists its
  background agents and shell tasks with when they started, when they last
  did something, how they ended and the exit code where it is known. A
  session with background agents running no longer reads as inactive.

- **Agents can check what the provider plans have left.** `remote_relay`'s
  new `usage` action answers, for the relay an agent runs on or a paired
  one, what each provider's plan has left: Cursor's spend against its
  limit and when it resets, Claude's windows and whether a usage limit has
  paused turns, Copilot and Grok where they are tracked; a provider that is
  not set up says so. It needs only read permission and returns no account
  names, addresses or tokens.

- **Notes between agents fold away.** A prompt another agent sent a
  session, from a paired relay or from this one, and the session's reply to
  it show as one row, "note from linux-test · report builder · replied",
  which opens to both, on a desktop and on a phone. Your own messages and
  the replies to them stay as they are, and a turn you steered a message
  into, or one with a question or card open for you, is never folded. A
  note still being worked on stays open and folds by itself once it is
  answered; one you fold or open yourself stays as you left it.

- **Open a sub-agent's whole record.** A sub-agent's title in the composer's
  background-task panel opens a viewer with everything the agent did, in
  order: its thoughts, every tool call with its full input and its result,
  its reply text and the agents it started itself, live while it runs. The
  finished reply lists the turn's sub-agents as the same rows, with model,
  type, tokens, time and how they ended, so the record stays one click away.
  A child agent opens in place, and back returns to its parent. Stop is in
  the viewer too. Claude records everything; Copilot and Cursor show what
  they report. A tool result is kept to its first 4 KB, and a record to 2000
  entries. Only a page with the viewer open receives the record as it grows.

- **Choose how long sub-agent tool output is kept.** Settings → General →
  **Keep sub-agent tool output** offers 7, 14, 30 or 90 days (the default)
  or always. Once a finished agent's record is older than that, its tool
  inputs and results are removed, once a day; its thoughts, its reply, its
  notes and the one-line summary of each tool call stay, and the viewer says
  what was removed.

- **Folders can be created in the file browser.** A **📁+ New folder**
  button in the toolbar opens a row at the top of the folder pane; the name
  is typed there and Enter creates the folder inside the open one and opens
  it. It works in the repository, on the drives and in the session folder,
  and in the folder picker of **New chat** and **Change CWD**, so a new
  project folder can be made and picked in one go. A taken name or a name
  the system refuses is reported under the input.

- **Files and folders can be renamed and deleted in the file browser.** A
  right-click, or a long press on a phone, on a folder in the tree or a file
  in the folder pane opens a menu with **Rename** and **Delete**; a folder's
  menu also offers **New folder here**. Rename edits the name in place: Enter
  saves, Escape cancels, and an unchanged name is a cancel. Delete asks in a
  dialog that says what goes: a file, an empty folder, or a folder with so
  many files and folders in it; for a folder with content the folder's name
  must be typed before the red button enables. Links are never followed or
  changed; roots (the repository root, `/`, a drive, the session folder)
  cannot be renamed or deleted, and the session folder is read-only apart
  from new folders.

- **Jump back to the latest message.** A round ⌄ button above the composer
  fades in once the transcript is about a screen above its end, and its
  badge counts the rows that arrived since (an agent's folded exchange
  counts once). A click goes back to the end, smoothly up to three screens
  away and at once beyond, and the transcript follows new rows again; from
  a search result or a pin deep in the history it loads the end.

### Changed

- **Archiving a session whose process is still active asks first.** A green
  session, idle or working, now opens "Archive this session? Its process is
  still active." from the row's 🗄, its menu and the chat menu alike; Cancel
  or Escape keeps it. An inactive session archives at once, as before.

- **A message from another device no longer pulls a reader who scrolled up
  down to the end.** Another client's message, an agent's prompt included,
  is followed like any live row: only while the transcript is at its end.

- The npm package guard allows 6.75 MiB unpacked (was 6.5 MiB); the
  sub-agent records and the event subscriptions, now across paired relays,
  grew the server.

### Fixed

- **A dropped websocket can no longer take the relay down.** A browser that
  reset its connection while a preview's websocket, or any websocket to the
  relay, was still being set up ended the whole relay with `read ECONNRESET`.

- **A queued relay restart no longer waits forever on a busy relay.** The
  restart used to wait for the whole queue to empty while new messages kept
  being handed to workers, so each new turn postponed it again. It now waits
  for the running turns only; queued messages are held until the relay is
  back and run then. The banner says which.

- **Waking from sleep no longer restarts the running turns.** After the host
  slept for hours, every worker heartbeat looked hours old the moment the
  relay's timer fired again, so live turns were recovered as stale and their
  messages delivered a second time while the workers' own replies were
  refused, hundreds of warnings in minutes. The relay now notices the clock
  jump and gives live workers a full inactivity window to report before
  anything is recovered; a superseded attempt's refusals are logged once and
  summarized, not line by line.

- **A Cursor turn waiting on a long command is no longer ended as stalled.**
  When the agent started a command in the background and then waited for
  it, the wait counted as a model request, and the turn was ended after five
  minutes of quiet. The wait now gets the 30 minutes a running tool gets.

- **An event's fields cannot add lines to a watcher's event message.** A
  line break in a session title, a task description or a field of a paired
  relay's event could start a line without the `[relay event]` prefix. Every
  field is now written as one line, and what a paired relay sends is stored
  field by field from a fixed list, never as the payload it sent.

- **The relay event tables no longer grow without bound.** Delivered events
  and ended subscriptions were never deleted, and the retention check for
  paired relays scanned the whole event table every 30 seconds. Delivered
  events now go after two hours (the wake-up count reads the last hour),
  ended subscriptions after a week, and the check uses its index.

- **The "watching N sessions" list opens in full.** The header cut it off,
  so on a phone it did not show at all. It now opens under the chip on top
  of the page, and Escape or a tap elsewhere closes it.

- **Sub-agent runs a worker never closed no longer count as running work.**
  A run whose worker went away without reporting its end stayed `running`
  for good, so a subscription to all sessions never saw `all_idle` and
  reported the session stalled over and over, and the suspend watchdog saw
  work. Such runs are now closed shortly after the relay starts and every
  ten minutes (never while their worker is alive), and a run row not touched
  for a day is not counted meanwhile.

- **A background agent's output stays with the turn that started it.** Its
  thoughts and tool calls no longer land in a later turn's reply, and between
  turns they are no longer lost.

- **A background agent no longer shows as finished the moment it starts.**
  Its row now ends when the agent does.

- **A sub-agent stopped by a failed turn or a worker crash settles on screen
  without a reload.** The update used to arrive without its turn, and the
  page ignored it.

- **The transcript keeps following the live reply when a background task
  starts.** The task panel appearing, opening or growing shrank the
  transcript from below and left it that much short of the end, so the next
  live row stopped following. It now stays at the end.

- **The transcript follows the agent's reply as it streams in.** Each piece
  of streamed text was scrolled to before it was shown, so the first new
  line left the reader short of the end and the rest was not followed.

- **Going back to the end while a turn finishes sticks.** The reload at the
  end of a turn put a reader back where they were when it was asked for, so
  scrolling to the end, or pressing ⌄, during it was undone and the next
  rows were not followed. It now keeps where the reader is when it lands.

- **⌄ no longer opens the keyboard on a phone.** The composer is no longer
  focused when the page loads on a phone, and ⌄ keeps it focused only while
  the keyboard is already open, so a tap on it just scrolls.

- **A message that arrives while the conversation reloads stays on screen.**
  A reload asked for just before another client's message or a reply landed
  rebuilt the transcript without it, until the next reload. The reload now
  asks again when rows arrived on the way.

- **A message sent right after switching conversations shows up where it was
  sent.** A quick run through the list, or a click back on the conversation
  still open, could hand the view to an earlier click once the draft of the
  conversation left behind had saved. The message then went to that
  conversation, or its bubble and the live reply stayed hidden until the
  conversation was opened again. A click now opens its conversation at once.

- **The live reply stays on screen right after a send.** A poll answer read
  just before the agent took the message could end the turn on the page, and
  a reply update lost on a busy connection left the bubble empty; both waited
  for the conversation to be opened again.

- **Settings opens with no conversation open.** On a fresh install the ⋯
  menu did nothing until a chat existed, so no provider could be turned on.
  The menu now works on an empty screen, with the entries that need a
  conversation left out, and the empty screen and New Chat point to
  Settings → Providers until a provider is ready instead of starting a
  Copilot chat that cannot run.

## [0.9.9] — 2026-10-07

Highlights: `oar` opens a menu and gains stop, restart, status, url and
service commands, and setup asks for access and port; files open in a
fullscreen viewer with galleries to swipe through, and a PDF opens in the
browser; messages can be pinned; a downloaded file is the file as it is now,
and no cache may keep an API answer; the built-in Cloudflare tunnel uses the
`cloudflared` you installed instead of a bundled copy; the three provider
SDKs are current.

### Upgrade notes

- **The built-in Cloudflare tunnel needs `cloudflared` installed on the relay
  host.** An install that ran the tunnel (`cloudflaredTunnel` in the config)
  on the copy that came with OAR loses the tunnel after this update until
  `cloudflared` is installed: `winget install --id Cloudflare.cloudflared`
  on Windows, `brew install cloudflared` on macOS, Cloudflare's package
  repository on Linux (<https://pkg.cloudflare.com/>). The relay itself
  starts and works locally in the meantime. Installs with
  `cloudflaredTunnel.binary` set, with `cloudflared` on the `PATH`, or
  with a tunnel that runs outside OAR are not affected.

### Added

- **The file viewer fills the screen.** A file opened from the file browser
  or from a chat takes the whole screen: pictures, video and audio on black,
  text in a column that reads well on a wide screen. The title, the toolbar
  and the meta line float over the content; a tap on the content hides them
  and brings them back, and while a video or an audio file plays they fade
  by themselves after three seconds, as players do. Audio files play in the
  viewer. A PDF, which the viewer cannot show, is a card with **Open in new
  tab** (the browser's own viewer) next to **Download**.
- **Swipe through a folder, or through a chat's media.** A file opened from
  the browser's folder pane carries its neighbours along: a sideways swipe
  shows the next or the previous file, as do the arrow keys and the two
  buttons below with the position between them. A picture or an attachment
  tapped in a chat opens with every image, video and audio file of the
  conversation to swipe through, oldest to newest. Neighbours are fetched
  ahead, so a swipe lands on the file and not on "Fetching…".
- **The back gesture closes the viewer, and a swipe down dismisses it.** On
  a phone the system back gesture closed the app; it now closes the viewer
  and nothing else, and the address never changes. A swipe down on a picture,
  a player or a card lets the content follow the finger and then go.
- **The back button never closes the installed app.** In the app installed
  from the browser (Android, iOS, desktop), pressing back with nothing left
  to go back to used to close it. From the first touch on, the app keeps
  one entry beneath its own and steps back onto it: back closes the file
  viewer and nothing more, and a back with nothing left to close shows
  *Press back again to close the app* — a second press without a touch in
  between closes it, as phone apps do. (Before any touch the browser lets
  back leave on purpose; a page cannot change that.) In a browser tab the
  back button is the browser's as before.
- **`oar` opens a menu.** In a terminal, `oar` shows whether the relay runs,
  its version, URL, port, access and service, and offers Start, Stop, Restart,
  Show URL and QR code, Settings, Install or remove the service, Update,
  Doctor and Copilot session (arrow keys or digits, Enter, `q`). Without a
  terminal it prints the status and the usage.
- **`oar stop`, `oar restart`, `oar status`, `oar url`, `oar service`.** Stop
  and restart wait for running turns (the systemd service is stopped and
  restarted by systemd). `oar status` exits 0 when the relay runs and 3 when
  it does not. `oar url` prints the relay URL again. `oar service install`,
  `remove` and `status` manage the start at login: the systemd user service
  on Linux, the sign-in autostart on Windows; on macOS, and on a Linux
  without a systemd user session, the command says so and names `oar start`.
- **`oar setup` asks for access and port, with options for each.** In a
  terminal, setup asks for a new token, the access (this machine only, or
  LAN) and the port, each with its current value; Enter keeps it. `--port`,
  `--lan`, `--local` and `--new-token` answer without a question, and
  `--defaults` keeps everything of an existing config.
- **WSL: a port has to be free on Windows too.** In WSL's default networking
  a port can be free in the distro while a Windows program listens on it, and
  a Windows browser's `localhost` then reaches that program. A new config now
  takes the first port that is free on both sides, setup refuses a port
  Windows holds, and `oar start`, `oar status`, `oar doctor` and `oar setup`
  warn when Windows holds the relay's port. Where Windows cannot be asked,
  nothing changes.
- **Pin messages in a conversation.** Every message has a **Pin** button
  beside **Hide**. A conversation with pins shows a **📍** button with their
  count in its header; it opens the list of pinned messages, each with a short
  preview. A row scrolls to its message, also one far up in the history, and
  **🗑** unpins it. Pins are stored on the relay, appear on every open device
  at once, and are not part of the shared view. At most 100 per conversation.

### Changed

- **The Copilot terminal session is `oar copilot`.** `oar` alone no longer
  starts the relay and `gh copilot`. `oar copilot [-- <args>]` does; the old
  forms with an option and no command (`oar -- <args>`,
  `oar --install-extension`, `oar --no-install-extension`,
  `oar --migrate-from <dir>`) still run it.
- **Setup no longer asks about the tunnel or the service.** The service is
  `oar service install`; the tunnel is set in the config
  ([Remote access](README.md#remote-access)). `oar setup --start` still
  installs the service where a systemd user session exists.
- **A QR code only for an address a phone can reach.** With LAN access the
  URL and the QR code carry the LAN address. With access for this machine
  only, setup prints the localhost URL and one line on how to get phone
  access, and no QR code. In WSL a LAN address is internal to WSL: setup says
  so and names the two ways out, a tunnel or WSL's mirrored networking.
- The npm package guard allows 6.5 MiB unpacked (was 6 MiB); the command line
  grew by the menu and the new commands, and the app by the pinned messages
  and the file viewer.
- **A tunnel without `cloudflared` says so.** When the built-in Cloudflare
  tunnel is switched on and no `cloudflared` is found, the relay starts as
  usual, the tunnel stays off, and the status dot's tooltip, `oar doctor` and
  the server log name the install command for the system. The relay looks
  again every minute and starts the tunnel once `cloudflared` is there. With
  `cloudflaredTunnel.required` the queue stays paused until the tunnel is
  connected, as before.
- **`--allow-scripts` lists two packages.** A manual install on npm 12 is now
  `npm install -g --allow-scripts=better-sqlite3,koffi @oar-sh/oar`;
  `oar update` and the **Update** button pass the same list.
- `@github/copilot-sdk` 1.0.17 (bundled Copilot CLI 1.0.93): typed structured
  outputs for `sendAndWait`, structured JSON-RPC error data, an experimental
  `setTools()` to replace a session's client tools mid-session, sub-agent
  start/stop hooks, and the new session events `tool.shell_output` and
  `human_response.recorded`. The extension entry renames `factories` to
  `workflows`; OAR passes neither. The package now pins its own dependencies
  exactly, so it carries its own `zod` 4.3.6.
- `@anthropic-ai/claude-agent-sdk` 0.3.292 (bundled Claude Code 2.1.292).
  Of the nine releases since 0.3.283 these touch the relay's worker: a
  cut-short or interrupted streaming reply now always ends with its
  `message_stop` (0.3.287, 0.3.290), so the turn-liveness watchdog sees the
  end of the model's output; a follow-up turn woken by a finished background
  agent no longer fails its hooks, `canUseTool` and SDK MCP calls with
  "Stream closed" (0.3.284); `commands_changed` no longer arrives before
  `init` (0.3.287); a user message replayed under the same `uuid` while the
  first copy still waits is no longer replayed twice (0.3.290); subagent
  `assistant`/`user` messages carry `agent_id`, task events carry
  `parent_task_id` and `run_id`, and `background_tasks_changed` for a
  finishing task now arrives after its `task_updated` and `task_notification`
  (0.3.292). An omitted `permissionMode` is now left to Claude Code (0.3.286);
  the worker always passes one.
- `@cursor/sdk` 1.0.36 (additive API changes only): an opt-in
  `subagentInherit` for `Task` child sessions, `sessionId` in the custom-tool
  context, and the SDK's *default* agent-store path now derives from SHA-256
  with a one-time rename of the old MD5-named store. OAR passes its own
  `stateRoot`, so its stores under `data/cursor-agents` keep their layout.
  The package dropped its `@connectrpc/connect-node` dependency.

### Removed

- **The bundled `cloudflared`.** OAR no longer installs the `cloudflared`
  npm package, which downloaded the binary during the install. The tunnel
  runs the `cloudflared` named in `cloudflaredTunnel.binary` (or
  `COPILOT_CLOUDFLARED_BINARY`), or else the one on the `PATH`.

### Fixed

- **A jump into the history stays where it landed.** After opening a search
  result in an older part of a conversation, the page put the end of the
  conversation back as soon as it refreshed itself: within a second while a
  turn was running, and whenever a turn ended or the connection came back.
  The window you jumped to now stays until you scroll down to the newest
  message. The same holds for a jump to a pinned message.
- **On a phone, the Pin button of a message can be tapped.** A tap on a bubble
  reveals its Pin and Hide buttons, but the reveal hung on the hover state the
  tap leaves behind, which the browser drops at the next scroll or layout
  change (seen on Linux), and the share-visibility line then took the tap
  instead of the button. The tap now holds the reveal until a tap lands
  outside the bubble.
- **A PDF opens in the browser's viewer again.** Served files carry a
  `Content-Security-Policy` with `sandbox` so a worker-written file can never
  run as script on the relay's origin; browsers refuse to show a sandboxed
  PDF in their built-in viewer, so "open in a new tab" turned into a
  download. A PDF alone is now served without the `sandbox` directive (PDF
  viewers run no document script) and may be framed by the relay's own
  origin; HTML, SVG and every other type keep the full lock-down.
- **Audio files were an opaque download.** No audio type was known, so an
  `.mp3` or `.wav` went out as `application/octet-stream` with a download
  disposition. Audio types are served as such, previewed as audio, and
  `.bmp` and `.avif` are served as images.
- **An SVG can be previewed.** It was served as plain text so that a
  worker-written SVG could never run as a page on the relay's origin, and
  an `<img>` refuses plain text: the viewer and the file browser's
  thumbnails showed a broken picture. An SVG now keeps its type; the
  `sandbox` in every served file's `Content-Security-Policy` still denies
  it script and an origin if it is opened as a page.
- **Uploaded video can seek.** A video attachment in a chat was streamed
  without range support, so the player could not jump; it now goes through
  the same range-aware file serving as a workspace file, and so does a
  shared conversation's attachment. Their long-lived caching stays.
- **A file with a Japanese, Chinese or emoji name can be served again.** Its
  name went into `Content-Disposition` as is, which the HTTP layer refuses
  for characters outside Latin-1, so such a workspace file, upload or shared
  attachment failed with a server error and left a file handle open each
  time. The header now carries an ASCII fallback and the full name in the
  `filename*` form, so the file opens and is saved under its own name.
- **A changed file is downloaded as it is now.** The **Download** button of
  the file viewer handed back an older copy of a file that had been written
  again under the same name. Three things were wrong:
  - A click on Download did not download: since 0.9.0 every link click was
    turned into "open in a new tab", so the link's own file name was dropped
    and a phone showed or saved the file under its plain name, next to (or
    instead of) the copy it already had. Download links are left to the
    browser again.
  - A file fetched within two seconds of a change arrived cut to its
    previous length, because the announced length came from an older read
    than the bytes. Length, validators and bytes now come from one open file.
  - The address and the saved name never changed. The link now carries the
    file's version (`v=…`), and the file is saved with the time it was last
    changed, `report.pdf` as `report (1005-0719).pdf`.
- **No cache between the relay and you may keep an answer.** Every API
  answer, errors included, now says `Cache-Control: no-store` unless the route
  sets its own value, and every answer carries `CDN-Cache-Control: no-store`
  and `Cloudflare-CDN-Cache-Control: no-store`, which bind a CDN in front of
  a tunnel whatever cache rule its zone has. Served files also carry an
  `ETag` and `Last-Modified`.
- **A file preview could stop the relay.** The preview and file routes used a
  cache they were never given, so dropping a stale entry threw; in the
  preview route that happened outside any handler and ended the process.
- **A changed token, port or access reaches the running relay.** `oar setup`
  wrote the new value while the relay kept the old one, so the relay refused
  the token in its own config. Setup now restarts a running relay after such
  a change (in a terminal it asks first), with the old token on the old port,
  and waits until the relay answers with the new settings. If you decline, or
  the relay is still busy with a turn, `oar status`, `oar stop` and
  `oar restart` still find it.
- **The command may follow its options, and an unknown one starts nothing.**
  `oar --port 3339 setup` and `oar --setup` used to start the relay and
  `gh copilot` instead of running setup. The command is now found wherever it
  stands, `--setup`, `--start`, `--stop` and `--status` name it too, and an
  unknown command or option prints the usage and exits with code 2.
- **`oar copilot` checks the relay on its port, and says when `gh` is
  missing.** A lock file alone no longer counts as a running relay: the relay
  has to answer on the port. Without the GitHub CLI the command says so and
  starts nothing, instead of *spawn gh ENOENT*.
- **Ctrl+C in a prompt** ends the command quietly with exit code 130 instead
  of *Unhandled error*.


## [0.9.8] — 2026-10-04

Highlights: OAR has a logo, an otter, with icons that follow Day and Night
mode and a start screen that continues the phone's launch screen; a
*Compacting context…* line shows while a Claude session compacts, and a
changed auto-compact window now really applies; the one-line installer
finishes the job and `oar start` brings the relay up without a session;
scrollbars are easier to grab with a mouse.

### Added

- **The otter logo, matching Day and Night mode.** OAR has a new logo. The
  start screen and the sign-in box show it on a white tile in Day mode and on
  a dark tile in Night mode, and only the matching file is loaded. The tab
  icon, the toolbar colour and the installed app's icon and launch background
  follow the Theme setting too (Android launchers get a full-bleed icon that
  fills their shape), and the theme is applied before the first
  paint, so Day mode no longer starts with a dark screen. On Android the
  installed app's own launch screen updates when the system refreshes the
  app, which can take a day.
- **The installed app starts in one motion.** The start screen continues the
  phone's launch screen: the otter stands where and as large as the launch
  screen showed it, then slides up and shrinks while *Connecting to OAR…*
  fades in below. Without a stored token it travels on into the sign-in box,
  which fades in around it. Launch screen, start screen and status bar share
  one colour, so no plate shows around the logo. The app waits for the
  animation (under a second); a browser tab starts at once as before, and so
  does an installed app when motion is reduced in the system settings.
- **A compaction shows while it runs.** When a Claude session starts
  compacting its context, a *Compacting context…* line appears above the
  running turn and its bubble says *Compacting the conversation…*. When the
  compaction ends, the same line becomes *Context compacted · 120k → 40k
  tokens*; one that ends without a result leaves no line.
- **`oar start`, and `oar setup --start`.** `oar start` starts the relay of a
  global install in the background, without a Copilot session tied to it
  (through the systemd user service when one is installed), and prints the
  relay URL. `oar setup --start` does the whole job without a question: where
  a systemd user session exists it writes and enables the service and enables
  lingering, elsewhere it starts the relay in the background. `oar setup
  --port <port>` sets the port; a new config otherwise takes the first free
  port from 3333 on.
- **The macOS and Linux installer does everything after one confirmation.**
  `curl -fsSL oar.sh/install | sh` prints what it will do, asks once (`--yes`
  skips the question), then installs OAR and starts the relay. Without
  Node.js, or with one older than 22.13, it downloads Node.js 24 from
  nodejs.org into `~/.oar/runtime/node` for OAR alone. Nothing needs root.

### Changed

- **Scrollbars are easier to grab with a mouse.** A scrollbar doubles its
  width while the pointer is on it and goes back to thin 2.5 seconds after
  the pointer left. The space for the wide scrollbar is always kept, so
  nothing on the page moves when it grows. Touch devices are unchanged.

- **The auto-compact window slider saves when the 🧠 modal closes.** Moving
  it only changes the label and the notes beneath it; the value is saved
  when the modal is closed, and setting it back sends nothing. A notice
  warns when the new window is below what the conversation already uses
  (*The conversation will be compacted on the next message.*), and another
  says when the change takes effect: after the current turn, when
  background work has finished, or on the next message. The modal's
  headline reads `60.9k used · compaction window 100.0k · model limit 1M`.

### Fixed

- **`oar start` no longer mistakes a leftover lock or another program for a
  running relay.** It asks the relay itself: only an answer to OAR's own status
  call with the configured token counts as running. A lock left behind by a
  relay that did not stop cleanly is removed and the relay is started; if
  another program holds the port, `oar start` says so and names
  `oar setup --port`.
- **A new config no longer picks a port that is in use on Windows.** The
  free-port check binds the loopback addresses as well as all interfaces and
  tries a connection, since Windows allows a wildcard bind beside a listener
  on 127.0.0.1 alone.
- **The compaction line survives a busy turn.** The live *Compacting context…*
  / *Context compacted* line used to disappear after two dozen further
  activity lines until the next reload.
- **The auto-compact slider is saved when the page closes.** Closing the tab
  or the app with the context window still open used to drop a moved slider.

- **A "Compacting context…" line no longer stays on a waiting message.** When
  the session compacted while a message waited behind a turn the agent had
  opened itself, the line stayed on the waiting message for its whole turn.

- **A new auto-compact window now reaches a running Claude session.** The
  CLI reads the window only when it starts, so a changed window used to wait
  until the session restarted for some other reason. The session now
  restarts once, before the next message, when nothing is running in it
  (no turn, question, compaction or background work); the reply notes it
  (*Restarted the session to apply the compaction window (Auto → 100k)*).
- **The installer no longer fails with `EACCES` on a Node.js from a
  distribution or NodeSource package.** There npm's global folder needs root,
  and the installer refuses to run as root, so the install could not succeed.
  It now installs the package into `~/.oar/npm` and puts the `oar` command
  into `~/.local/bin`.
- **Updates land in the install that is running.** `oar update` and the
  **Update** button ran whatever `npm` was first on `PATH` into npm's default
  global folder. They now run the npm of the Node.js that runs the relay, into
  the folder the package is installed in, so an install made with `--prefix`,
  a relay service without `npm` on its `PATH`, and a version manager pointing
  at another Node.js all update correctly.
- **Installs and updates work on npm 12.** npm 12 runs no install script it
  was not told to allow, so `better-sqlite3`, `koffi` and `cloudflared` were
  installed without their binaries and the relay did not start. `oar update`,
  the **Update** button and both installers now pass `--allow-scripts` for
  these three; for a manual `npm install -g` the README gives the flag.
- **The systemd user service finds your tools.** The unit `oar setup` writes
  now carries the `PATH` of the shell that ran it, plus `~/.local/bin` and the
  directory of its Node.js. A user service otherwise starts with systemd's
  bare `PATH`, on which the relay's sessions found neither the provider CLIs
  nor, with a version manager, `node` itself.

## [0.9.7] — 2026-10-03

Highlights: Claude Cloud chats (experimental, off by default) run Claude Code
in a sandbox at Anthropic on a GitHub repository; conversations can be
archived and have a context menu in the list; agents can start and use
sessions on the relay they run on; commits of Claude sessions say "Open
Agent Relay"; Check Usage opens at once.

### Added

- **Archive conversations, and a context menu in the list.** Every
  conversation row has an **Archive** button beside Delete (and the chat's
  `⋯` menu an **Archive conversation** entry). An archived chat leaves the
  list and its session worker is stopped; the 🗄 toggle at the top of the
  sidebar shows the archived chats, each with **Unarchive**. A Claude Cloud
  chat's cloud session is archived and unarchived at Anthropic with it. A
  message into an archived chat (an agent's, say) brings it back by itself;
  the composer of an archived chat says so instead of sending. A right-click
  on a row — a long press on a phone — opens a menu with Open, Edit title,
  Stop turn, Kill session, Archive/Unarchive and Delete.
- **Commits made from OAR say so.** Claude sessions now end their commit
  messages with `Co-authored-by: Open Agent Relay (<model>) <no-reply@oar.sh>`
  — the model's name in the parentheses, e.g. `Claude Fable 5.1` — and pull
  request bodies with `🤖 Generated with [Open Agent Relay](https://oar.sh)`,
  instead of Claude Code's own lines. Settings → Providers → Claude has the
  choice: **OAR** (the default), **vanilla** (Claude Code's own attribution)
  or **off** (none); a repo folder can override it from the 🧠 context modal
  of any of its Claude sessions. A change reaches running sessions with their
  next message. Claude Cloud chats follow the same setting: the sandbox gets
  it with the first message and again when it changes, and in OAR mode the
  `Claude-Session` link is left out of the commit as well. Other providers
  are not touched: their tools have no such setting.
- **Claude Cloud (experimental): chats that run in a sandbox at Anthropic.**
  A new provider, off by default. A Claude Cloud chat runs Claude Code in
  Anthropic's cloud, on its own clone of a GitHub repository instead of on
  the relay host. It is billed to the Claude account the host's Claude CLI
  is logged in to, and its results come back as branches the agent pushes.
  Switch it on in Settings → Providers → Claude Cloud and choose the cloud
  environment and a default model there; it needs the Claude CLI logged in
  with a claude.ai account on the relay host, GitHub connected to that
  account, and the Claude GitHub app allowed on the repository.
  - **New Chat** fills **Repository** and **Branch** from the folder you
    pick, offers the repositories the Claude GitHub app can reach (the ones
    used here before first) and the branches of the picked repository, lets
    you type both, and warns about commits that are not pushed, changes
    that are not committed and a repository the app cannot reach.
  - **In the chat** the reply streams in live, the agent's questions and
    permission prompts arrive as cards, **Stop** interrupts the turn, images
    can be attached, and the model can be changed between turns. A line
    above the composer links the session on claude.ai and every branch the
    agent pushed to its comparison on GitHub, and shows the cost so far.
  - **Turns** survive a restart of the worker or the relay without sending
    your message twice. A turn stays open while the agent's background work
    runs, a turn the session starts by itself (after long background work,
    or from a message sent on claude.ai) appears as a reply of its own, and
    a turn refused at the usage limit is paused until the reset like a
    local Claude turn.
  - **Commits** follow the relay's attribution setting (see above), and
    deleting or archiving the chat archives the cloud session.
  - **Not there:** relay modes, a reasoning effort, steering during a turn,
    files other than images and anything else from the relay host, and the
    relay's tools and previews inside the sandbox.
  - **Before you switch it on:** the provider uses the Claude CLI's stored
    login to call the Anthropic API endpoints the CLI itself uses. These
    are not a documented public API and may change. OAR only reads the
    token: it never stores or logs it and sends it nowhere but to
    Anthropic; when it has run out, OAR lets the CLI refresh it. While the
    provider is off the relay fetches nothing with that login, except for
    cloud chats you created before. See "Claude Cloud" in the README.
    `scripts/claude-cloud-live-check.mjs` checks a running relay's Claude
    Cloud end to end.
- **Check Usage: live Claude limits and a Claude Cloud card.** With Claude
  Cloud switched on, the Claude card reads the 5-hour, weekly and per-model
  limits live from the account when you open the modal, instead of showing
  the reading of your last Claude turn, and a limit that is getting close
  carries Anthropic's warning. The card also shows which product the week
  went to (Claude Code, chats and the others) and the organisation's prepaid
  credits. The new Claude Cloud card shows the account's cloud credit (used,
  left, and when it expires) and what the cloud chats on this relay have
  cost as Anthropic reports it, in total and for the chat you opened the
  modal from; a credit that is offered but not yet claimed is mentioned with
  a link. The limit-reset vouchers (full reset, 5-hour reset) stay
  claude.ai-only: no endpoint the CLI's login reaches carries them, so the
  card links to the usage page instead. With Claude Cloud off, the Claude
  card is what it was.
- **Agent sessions: an agent can hand parts of its task to other sessions on
  the same relay.** The `remote_relay` tool now also works on the relay the
  agent runs on: it starts sessions there, waits for them and reads their
  replies, and each one is an ordinary conversation in your list. Off by
  default; switch it on in Settings → Relays → Agent sessions (**Agents may
  start and use sessions on this relay**). No relay has to be paired. The
  first time the agent of a conversation starts a session, a card asks you
  once for that conversation. At most 4 sessions it started may be at work at
  the same time, a session that an agent created cannot start sessions
  itself, and an agent cannot prompt, stop or archive the conversation it
  runs in. A session can use any provider that is enabled on the relay
  (image chats excepted); a Claude Cloud chat is started with the new `repo`
  and `branch` arguments, and an agent on a paired relay can now start a
  cloud chat here the same way. Sessions an agent starts use this relay's
  accounts, show **via agent** with the title of the conversation they came
  from in the sidebar and the header (a click opens it), and are never
  archived automatically. The new
  **Longest wait per tool call** slider in the same place sets how long one
  call may wait for a reply: 10 minutes as before, up to 60; it applies to
  waits on paired relays too. See "Agent sessions" in the README.

### Changed

- **Check Usage opens at once.** The modal shows the reading it showed last
  time immediately and reads only the open tab's provider live (the card says
  "updating…" meanwhile), instead of fetching every provider and showing a
  spinner until the slowest answered. A tab you switch to is read live when
  its reading is older than a minute; **Refresh** reads the open tab only.
  The relay keeps the last live answer of every provider, so the other cards
  stay filled (`GET /api/usage?providers=…`).
- **Windows: the relay no longer stops while it reads the process list.**
  Before every launch, every kill and every check of a worker that went
  quiet, the relay reads the list of all processes through PowerShell. It
  did so synchronously: half a second to a second and a half on an idle
  machine, several seconds under load, during which the relay answered
  nothing — under CI load that was enough for the tunnel to report 502 for
  the whole relay. The list is now read off the relay's thread; callers that
  ask at the same time share one read, and a read is reused for 1.5 s. A
  worker that went quiet is checked by its pid first and by the list last.
  `GET /api/status` → `sessionWorker.processList` shows when the list was
  last read, how long it took and whether it failed; a read slower than two
  seconds is logged. A kill or a workspace relaunch that cannot read the
  list answers 409 with the reason instead of failing with 500 or stopping
  blind.

### Fixed

- **A reply that names an error code is a reply.** A reply a session
  worker published was read as a failed turn when its one paragraph led up
  to "Error code: relay.…" — a short report on a test that had failed with
  that code, for instance. Workers always send the failure as a record, so
  their replies are no longer read for one; the page's fix buttons under a
  failure follow the same rule and no longer appear under a reply that
  mentions a code in a quotation, a code span, a table or a list.
- **Two prices in one paragraph were shown as a formula.** In a reply such
  as `this run cost $4.20, the earlier one $3.80`, everything between the
  two dollar signs was rendered as maths. A dollar sign now starts a formula
  only when it is written the way inline maths is: no space after the
  opening sign, no space before the closing one, and no digit right after
  it. Prices stay text; `$x^2$` is still maths. A wide inline formula also
  no longer makes the whole message scroll sideways: it stays inside the
  bubble and scrolls within itself.

- **Windows: no worker could start once an agent had run a command with an
  arrow or a bullet in it.** Before every launch the relay reads the list of
  all processes through PowerShell. Under the console's OEM code page
  PowerShell wrote characters such as `→` and `•` as control bytes, the list
  stopped being valid JSON, and every launch on the relay failed: each session
  you wrote to turned yellow after six tries and stayed so, for every
  provider, until the relay was restarted. The list is now written as UTF-8, a
  control byte that still gets through is tolerated, a list the relay cannot
  read no longer stops a launch, and a session whose launches were exhausted
  is tried once more every minute instead of waiting for a restart.
- **A session whose worker cannot be started now says so.** Until now such a
  session showed a yellow dot and nothing else. The relay now writes one note
  into the conversation — why the worker could not be started, in one
  sentence plus the cause — and keeps that same note up to date: it tries
  again every minute for ten minutes, then stops and the note gets a
  **Retry** button for once the cause is fixed; when the worker starts, the
  note says so. Your message stays queued the whole time, and a queued
  restart of the relay no longer waits for a message the relay has stopped
  trying to deliver.
- **The Claude usage card showed extra-usage credits 100 times too high.**
  Claude reports these amounts in the currency's minor units (cents), and
  the card showed them as dollars: 12.50 used of a 50.00 limit read as 1250
  of 5000. The percentage was right.

## [0.9.6] — 2026-09-29

Highlights: a Claude turn pauses at the usage limit and carries on after the
reset, a command that prints nothing no longer fails its turn, and agents on
paired relays can work with each other for a whole session.

### Added

- The relay keeps a copy of its console in `relay-console.log` in its log
  folder (`server/logs` unless you moved it), with a time stamp per line. The
  file is rotated at 5 MB and three older copies are kept. The relay's token is
  never written to it. Set `OAR_NO_CONSOLE_LOG=1` to switch it off.
- **Claude usage limit:** a Claude turn that runs into the subscription's
  usage limit is paused instead of failed. Your message closes with a note,
  the relay queues a message of its own ("continue where you left off") and
  sends it a minute after the limit resets. A banner above the composer says
  when, with **Resume now** and **Cancel**. The pause survives a relay
  restart. A reset more than six hours away (a weekly limit) waits for you to
  resume it.
- A banner warns in Claude conversations when the usage passes 90 % of a
  limit, with the time of the reset, and can be hidden until the next one.

### Changed

- **Remote relays:** agents on paired relays can now work with each other for
  a whole session. A relay you mentioned stays in reach whatever prompts arrive
  later, and a relay whose agent wrote to a conversation is open to it, so the
  agent that was asked can answer, ask back or report later. Until now a prompt
  from another relay's agent took the tool away for the rest of the turn, also
  in a turn you had started yourself. A prompt that crossed two relays is still
  not passed on to a third relay you did not unlock; reading and waiting are no
  longer limited. After 30 prompts to other relays' agents without a message
  from you, the next one asks you first.
- Subagents are folded to their header inside the running turn, so a turn with
  many of them stays short to scroll. The header says how many steps the
  subagent has taken and shows the latest one, as far as there is room. A tap
  on the header unfolds a subagent and folds it again; what you chose by hand
  stays. The Stop button of a finished subagent is gone.
- **Copilot, Cursor, Grok:** how long a turn may stay quiet now depends on what
  the agent is doing: 2 minutes with nothing in flight, 5 minutes during a model
  request, 30 minutes while a tool runs. Until now every silence of 2 minutes
  failed the turn, including a command that simply printed nothing. The failure
  note says how long the silence was and what was running. The three windows can
  be set with `OAR_TURN_STALL_IDLE_MS`, `OAR_TURN_STALL_MODEL_MS` and
  `OAR_TURN_STALL_TOOL_MS`.
- **Copilot:** a turn kept past 2 minutes of silence is checked: a runtime that
  no longer answers fails the turn at once. The watchdog also covers the start of
  a session, where a runtime that did not answer used to hold the message without
  any failure, and a Stop during that start now takes effect at once.
- **Cursor:** a stalled run is cancelled, so the next message does not wait for
  it.
- A plan board is part of the reply it belongs to: its content and its buttons
  are shown inside the agent's reply bubble (inside the running turn's bubble
  until the reply is there) instead of on a card of their own at the end of the
  transcript. When the reply already is the plan, the plan is shown once, with
  the buttons below it. After you chose, the plan stays and the bubble says
  what was chosen.
- The choice on a plan board also sets the mode of the session: after
  "Implement in autopilot" the composer says Autopilot, after "Stop here and
  prompt myself" it says Agent, and the next message carries the work on. The
  session used to stay in Plan, so the next message planned again. "Stop here"
  leaves the mode as it is.

### Fixed

- A session worker that was idle and whose process has ended (stopped from
  outside, or crashed between turns) is no longer listed as ready with its old
  process id. The next message started a new worker before as well; the list
  now says what is there, about a minute and a half after the process ended.
- A reply that quotes or describes a failure note (an agent reporting on a
  failed test, for example) is no longer taken for a failure itself. The relay
  cut such a reply off at the quoted error code, put its own advice behind it
  and stored the turn as failed. Where a failure is known from its text alone,
  that text is now kept whole.
- A single `~` in a reply ("about", as in "~35 s … ~7 min") no longer strikes
  out the text up to the next one. Strikethrough needs two tildes on each side:
  `~~text~~`. The page now names the version of its Markdown library (15.0.12,
  the one it was served until now) instead of taking whatever the CDN hands out.
- **Copilot:** a command the agent had started no longer runs on after its
  runtime is gone. When the runtime died or was killed in the middle of a turn,
  the turn failed as it should, but the command kept running with nobody left
  to read its result. The relay now stops what such a runtime leaves behind
  (first gently, then by force), and the failure note says that a command that
  was still running is being stopped, as far as that is known at that moment:
  the note comes at once and does not wait for the list of processes. A command
  the agent started to outlive the session (`detach`) is left alone, and so are
  the commands of a runtime that shuts down in good order.
- **Grok:** a quiet-turn window that is set for the model request or for a tool
  is kept when the shared watchdog is switched off by the environment, and the
  watchdog looks often enough for the shortest window that is set.
- **Windows:** stopping or deleting a session could end the worker of another
  session as well. Windows hands the process id of an ended process out again,
  and a worker whose creator was long gone could so look like a child of the
  session that was being stopped. A process older than its parent is no longer
  taken for its child, and the worker of another session never is.
- **Copilot:** a message sent while a command is running no longer cuts the
  command short. It waits until the running tool call has ended and is steered
  in then; the composer reads "Queue" for as long. Sent at once, the message
  made the runtime push the command to the background: the turn ended early
  with the answer to the new message alone, or failed with "No response was
  returned", and the command's result arrived later in a turn of its own.
- A plan board's action ("Implement in autopilot" and the like) queues its
  follow-up again. It failed with an error and left the board marked as acted
  on, without the message that carries the plan out.
- A finished subagent no longer turns back to "Running" in the running turn
  when another line of activity arrives or the page reloads.
- **Previews:** the first page load after a dev server was restarted no longer
  ends in "The upstream connection failed: ECONNRESET". The preview lane keeps
  its connections to the dev server, and the one it had kept was closed by the
  restart. A request without a body is now sent once more on a connection of
  its own: it reaches the restarted server, or the page says that nothing is
  listening on the port.
- Links in the file viewer and in plan boards have a colour that can be read in
  dark mode; they used the browser's default blue.
- A question or approval card no longer answers itself when the relay is
  briefly unreachable, for example while it restarts. One failed check used to
  end the wait: the agent was told to use its own judgement, or the approval
  was refused, while the card stayed on screen. The wait now lasts through the
  outage, for every provider.
- **Copilot:** a turn that fails is reported at once. The failure used to wait
  for the runtime to finish stopping, which took three minutes on a runtime that
  had stopped answering; stopping it is now bounded, and the next message waits
  for it before a new runtime starts.
- **Copilot:** a failed turn keeps what the agent had written, above the failure
  note. The note says how many tool calls ran and that their changes are still in
  place, and it no longer advises restarting the relay. A message steered into
  the failed turn gets a short marker with Resend instead of a second copy of
  the failure.
- **Copilot:** a slow relay no longer makes a busy runtime look silent.
- **Copilot:** a reply the relay could not take (it was restarting, the
  connection was reset) is offered again for up to five minutes. One failed
  attempt used to put the message back in the queue, which threw the finished
  answer away and ran the prompt a second time. A reply that cannot be saved at
  all ends as a failure that says so, and nothing is run twice.
- **Copilot:** what the agent does by itself after a background task (a
  continuation) is kept while the relay restarts. Its row was given up after
  about a second, and the whole reply with it.
- **Copilot:** a relay that accepts live output and does not answer no longer
  holds the turn: a live update waits 10 seconds at most, and after one that
  ran out, live updates are skipped for 30 seconds. Tool lines skipped then are
  missing from the transcript; the reply is not affected.
- **Copilot:** Stop works on a turn that is stuck. A runtime that does not
  answer the Stop within 10 seconds is ended with the turn, and a turn the user
  stopped ends as stopped even when the runtime died or went silent after it.
- **Copilot:** a runtime that exits, or stops answering, while the agent works
  by itself after a background task is cleared away; the next message used to
  fail on it. A lost connection during a model change is reported as that, not
  as "pick another model".
- **Copilot:** a failed turn tells its failure once. A message sent into the
  turn that the agent had not started on gets the short marker with Resend,
  like one it had taken in.
- **Copilot:** background agents and shells are no longer closed with the
  runtime because its list of them could not be read.
- **Stop button:** Stop keeps working for a message that waits on a question
  card while the agent starts and finishes other work, and for a second message
  stopped while the same turn goes on. It used to do nothing in both cases.
- **Copilot:** a turn the runtime itself ended with an error no longer tells
  you to restart the relay. The worker starts a fresh runtime by itself; a
  restart repairs nothing and costs every other running session.
- The note under a failed turn no longer advises restarting the relay: a restart
  repairs nothing there and interrupts every other running session. It now says
  to send the message again and to include the error code in a report.
- **Claude:** a turn the Claude account refuses (billing, an expired sign-in,
  access the organisation has switched off) says to check the account or to sign
  in again in Settings → Providers → Claude, with a button that opens the panel,
  instead of "Retry the message". Its error code names the failure, for example
  `relay.claude-billing-error`; it used to read `relay.claude-success`.

## [0.9.5] — 2026-09-27

Highlights: a Claude reply on the wrong row no longer blocks the conversation,
workers on Windows write a log, and agents can set the effort of a session on
another relay.

### Added

- **Remote relays**: an agent can set the reasoning effort of a session it starts or
  prompts on another relay (`effort` on `create_session` and `send`), and `relay_info`
  lists the efforts each model there takes.

### Changed

- Session workers on Windows now write the same `worker-<session>.log` as on
  Linux, in the relay's log directory; the console window keeps showing the
  output.

### Fixed

- **Remote relays:** waiting for a remote agent's reply no longer stops at an
  interim answer ("still waiting for …") while the agent goes on in a turn of
  its own without a background task, for example while its subagents work.
- A Claude reply published as a *background continuation* instead of under
  your message no longer blocks the conversation for up to 5 minutes: after
  about 45 seconds of silence your message closes with a small muted note
  naming that reply, and the next message runs normally. The note sends no
  second notification, and an agent on a paired relay receives the reply
  itself, not the note. A stray re-init of the Claude CLI between turns no
  longer sends the reply there in the first place.

## [0.9.4] — 2026-09-27

Highlights: remote relays (pair OAR relays and let an agent on one work on the
other), follow toggles for the running reply, and a Suspend host that waits for
agents, background tasks and CI to finish.

### Added

- **Remote relays**: pair OAR relays in **Settings → Relays** by pasting the other
  relay's web address; the pairing works both ways. Agents of every provider get a
  `remote_relay` tool to list and read the other relay's sessions, prompt one, start
  a new one, wait for its reply and relay its questions to you. A relay unlocks in a
  conversation only once you mention it (`@` picks it from a list). Per relay, agents
  may read, prompt or do everything; in ask and plan mode each write action asks you
  first. The receiving relay marks such messages with a **↗ from …** badge. Tokens
  stay on the relay; agents never see them.
- **OAR MCP server** (`server/mcp/oar-mcp-server.mjs`): Grok and the Copilot
  extension engine now get the `preview` and `remote_relay` tools as real tools
  instead of instruction text.
- **Follow the live reply**: three toggles in the running reply's header keep
  its thoughts, its answer or its tool list pinned just above the composer as
  the reply grows. Scrolling the transcript by hand turns it off; typing in the
  composer does not. The choice is remembered per conversation until the page
  reloads.
- A queued relay restart shows a banner on every client, with a **Cancel**
  button (a new localhost-only cancel endpoint behind it).

### Changed

- **Suspend host waits for the work to finish.** Instead of sleeping the
  machine at once, the relay queues the suspend and fires it after 2 minutes
  with nothing active: no queued, running or parked turn, no background task of
  a live worker, and no open GitHub Actions run in a busy conversation's
  repository (read through `gh`; a repository whose state cannot be read blocks
  for 15 minutes, then is ignored). With nothing running at confirm time it
  fires after a 30-second countdown. The confirmation lists what is still
  active, every client shows a banner with the blockers or the countdown and a
  **Cancel** button, and a push notification reports the suspend, or its drop
  when the relay restarts. Suspend remains Windows-only;
  `OAR_HOST_SUSPEND_DRY_RUN=1` logs instead of suspending.
- **Stop** asks for confirmation before cancelling the running turn.
- The **Install app name** setting is now called **Relay name**. Your value is
  kept. It still labels the installed app, and it is the name paired relays
  know this relay by; when it is empty, paired relays see the machine's
  hostname.
- Dependency updates clear all five `npm audit` findings, one of them rated
  high: express 4.22.3, body-parser 1.20.8, qs 6.16.0, fast-uri 3.1.8 and
  hono 4.13.9. All were inside the declared ranges, so `package.json` is
  unchanged; a git checkout gets them with `npm ci`.

### Fixed

- Switching the Claude model in a conversation that already had replies no
  longer strands the next message. The reply to the message that carried the
  switch landed on a *continuation* row while the message itself stayed
  processing, and every later message waited behind it for up to 5 minutes, or
  until the session was killed.
- **Requests on an idle connection are no longer reset.** The relay closed a
  kept-alive connection after 5 seconds without traffic, so a request sent on
  it a moment later could be reset before the relay read a byte. Behind a
  reverse proxy or tunnel that pools its connections this showed up as an
  occasional 502, and a send was not repeated. Idle connections now stay open
  for 65 seconds.
- After a send, the transcript stays at the newest message when the composer
  grows (a session note or a warning banner appearing under it). It used to
  slip up until the draft was saved.

## [0.9.3] — 2026-09-27

Highlights: mid-turn steering on Claude and Copilot, Copilot background tasks on
par with Claude's, multi-select question cards, drafts that stay safe across
devices, and a sidebar title filter.

### Added

- **Mid-turn steering** for Claude conversations: messages sent while a turn is
  running are pushed into the live turn (any number of them — Claude Code
  parity) instead of queueing behind it. Folded messages settle with a compact
  *merged* marker; a message the CLI answers on its own turn gets its real
  reply as before.
- A **conversation title filter** above the sidebar list. Case-insensitive,
  clears with × or Escape, and automatically loads older pages while active so
  it searches every conversation, not just the loaded ones.
- **Resend** on a steered message that was cut off by **Stop**: the marker
  reads *Stopped with the turn — not answered* and one tap sends the original
  text and attachments again. Each original can be resent once (again only if
  that Resend was cancelled or failed), and the button reads **Resent** on
  every device and after reloads.
- The running reply's **Stop** header stays pinned at the top of the chat
  while a long reply scrolls, so it is always in reach on a phone.
- Background subagents in the task panel show the **model they actually run
  on** (e.g. *Opus 5.5*) beside their kind pill, and the **command they are
  running right now** with its tool emoji (e.g. *🔧 Tool (Bash): npm test*),
  cropped to the row — instead of *using Bash · opus*.
- **Mid-turn steering for Copilot conversations** (SDK engine, hosted and
  BYOK alike, every Copilot model): a message sent while a turn runs is
  pushed into the live turn. The runtime folds it in at the next tool boundary
  (the message settles with the same *merged* marker as on Claude, and the
  reply continues in the running bubble) or, when the model is mid-sentence,
  answers it right after on its own bubble. The composer reads **Steer** for
  these conversations; while a question card, approval, elicitation or a
  compaction is open it reads **Queue** and the message waits in the queue,
  cancellable, then steers in one round-trip after the answer. **Stop** now
  ends only the reply — background agents the turn started keep running under
  their own Stop — and messages pushed just before the Stop settle as *Stopped
  with the turn — not answered* with **Resend**, exactly as on Claude.
- Messages steered into a running turn (Claude and Copilot) carry a short
  hidden note telling the model to handle them in addition to the request it
  is working on. In testing, a model that received a steer before its first
  output answered only the new message and dropped the original request.
- The newest message you steered into a running Copilot turn keeps its
  **Cancel** until the runtime picks it up: cancelling pulls it back out of the
  runtime, so it is never answered. (Copilot's queue can only give back its
  newest waiting message, so older ones lose Cancel once pushed, as on Claude.)
- **Background tasks for Copilot conversations** now match Claude's: background
  agents the model spawns and detached shells appear in the task panel as they
  run, with the agent's kind, the model it runs on, the command it is running
  right now, its token count and a **Stop** that works (the runtime's task
  registry). A reply no longer waits for a background agent to finish; the
  agent's result arrives afterwards as its own *continuation* reply, and the
  relay's *Background task timeout* slider now governs Copilot tasks too
  (expiry stops them instead of silently forgetting them).
- **Multi-select question cards.** A question that allows several answers
  renders checkmarks instead of one-shot buttons, plus one **Reply with
  selection** button; the reply lists every ticked choice and whatever you
  typed in addition. Previously the first click answered the whole card.
  Claude cards follow Claude's own `multiSelect` flag. Copilot models get the
  relay's own `ask_user` tool, which adds a `multi_select` field to the
  runtime's (the built-in has no way to say "pick several"); a question worded
  "select all that apply" counts too, and every Copilot choice card has a
  **Select several** switch for the cases a model forgets to flag.

### Changed

- Copilot replies settle when the main agent goes idle rather than when the
  whole session does, so a background agent the turn spawned no longer keeps
  the reply's bubble spinning for as long as it runs; the agent's own
  follow-up arrives as a *continuation* reply, as on Claude. A background agent
  that asks a question, or in ask mode asks to run something, after the reply
  settled gets its card on a row of its own; approvals follow the
  conversation's current mode, not the one the session started in. A
  follow-up turn that ends with nothing to show (no text, and no activity
  beyond the background agent's own bookkeeping, such as its granted
  permissions) no longer leaves an empty "completed without a text reply"
  row. Messages
  are sent to the Copilot runtime as `immediate` throughout — the only mode
  that never strands a message behind background work.

- The background task panel scrolls when it holds more tasks than fit,
  instead of growing past the window — in phone landscape too, where the
  composer now always stays on screen.
- The **Background task timeout** setting defaults to **4 hours** instead of
  no limit, for Claude and Copilot alike: long-running work still finishes,
  but a forgotten shell or agent no longer keeps its session alive forever.
  A value you already chose (including *No limit*) is kept.
- Rotating a phone to landscape keeps the portrait text size instead of
  jumping to the larger desktop size, and opening the on-screen keyboard
  no longer shrinks it.
- Rotating a phone (or resizing the window, or opening the keyboard) keeps
  your place in the transcript: a reader at the end stays at the end, and
  mid-history the same message stays at the top of the screen. Previously
  the reflow left you screens above where you were, usually further back.
  A question card's reply box you are typing in stays in view when the
  keyboard opens.

- The composer's send button no longer turns into **Stop** while a turn runs.
  It reads **Steer** when a Claude turn is live and text is drafted, and stays
  disabled on an empty composer. While steering is held (open question card or
  plan approval, compaction) it stays enabled and reads **Queue**, with the
  reason in its tooltip: the message waits as an ordinary pending bubble (with
  **Cancel**) and steers into the turn once the card is answered or the
  compaction ends. Stopping lives where the work is: the running reply's bubble
  carries **Stop**, and queued messages carry **Cancel** until they are picked
  up. The label follows the worker within about a second, including right
  after a worker starts or the relay restarts.
- Queued messages are claimed strictly in send order, including messages that
  went through a delivery retry. Previously a retried message could starve
  behind newer ones for minutes in an active conversation, or run after them
  so replies arrived out of order.
- `@anthropic-ai/claude-agent-sdk` 0.3.283 (bundled Claude Code 2.1.283),
  which makes **Claude Opus 5.5** (`claude-opus-5-5`, plus its 1M-context
  variant) discoverable. Model discovery runs the SDK's bundled CLI, so
  `claude update` alone never surfaces a new Claude model.
- `@github/copilot-sdk` 1.0.14: typed message provenance (human vs. system vs.
  agent senders), a `fast` auto-routing tier, a `managedSettings.clearCache`
  RPC, and streaming-throughput fixes.
- `@cursor/sdk` 1.0.32 (additive API changes only).
- The npm package no longer ships test fixtures and test harnesses.
- The README is reorganized around installing and using OAR; relay internals
  and development notes moved to DEVELOPING.md.

### Fixed

- **Deleting a conversation no longer leaves its session running.** Its
  worker used to keep running (about 40 MB each, holding its workspace
  folder) until the relay restarted, and Claude and Copilot SDK
  conversations never had their CLI session removed. Delete now stops the
  worker first, removes the CLI session (Copilot through the SDK, Claude by
  deleting that session's transcript) and the conversation at once. A
  Copilot session the relay only imported from the host, and never ran, is
  hidden instead: its CLI session stays, and no process is stopped for it. A
  conversation that is still working, with a running turn or live background
  tasks, is not deleted: the sidebar says why, so you can stop it first (a task
  without a Stop button: use **Kill session**). A worker that a failed turn
  marked as errored counts as working for as long as its process runs.
- A message starting with "/" (other than the relay's own `/compact` and
  `/preview`) that reached a Claude conversation between turns ran as a Claude
  CLI command instead: Claude never saw the text, and the next reply was
  pinned to that message. It now reaches Claude as the text you typed, as the
  composer's "send again to send as text" promises.
- A Copilot turn that ended in `task_complete` after streaming a fragment
  published the fragment as its final reply; the completion summary now takes
  precedence in the saved reply too, not only in the live stream.
- A background subagent's own events could open a spurious *continuation*
  reply after the Copilot turn that spawned it had settled, and its
  session-level model notice could confuse a pending model switch.
- Switching the model, mode or effort between turns no longer strands the
  next message: the Claude CLI re-initialises after such a change, and the
  worker took that for a turn it opened on its own, so the reply landed on
  a *continuation* row while the message itself stayed processing with an
  empty Stop bubble (until the session was killed). A background task's reply
  that arrives during such a switch still gets its own row instead of
  trading places with the message's reply.
- A steered message could wedge its conversation indefinitely when a
  long-running (or hung) background task was alive: the merge settle waited for
  a full idle that never came, keeping every later message stuck behind it.
  Background tasks no longer block the settle; delivery watchdogs share the
  same rule.
- **Drafts no longer get overwritten across devices.** The draft version check
  never actually ran, so an idle device re-saved its stale (usually empty)
  composer over another device's draft every few seconds. Saves are now
  version-checked and happen only on real edits; a device you are not typing
  on picks up the other's draft, and when two devices edit at once the newest
  keystroke wins and the other text is offered back with **Restore** (and
  **Undo**).
- Other ways to lose a draft are fixed too: text typed or attachments added
  while a send was in flight, switching conversations mid-send or before the
  next draft loaded, reopening the open conversation (which dropped its draft
  attachments), a failed send overwriting what was typed meanwhile, and drafts
  over 20,000 characters re-saving in a loop (the saved part is now cut
  cleanly, and the composer says the rest is not saved).
- A steered message could run twice: Claude had already answered it, but the
  relay's recovery (or a worker crash or restart) delivered it again. Steered
  messages are now handled at most once: if the outcome cannot be recorded, the
  message ends with an error telling you to check the reply above rather than
  being run again.
- A message sent while a question card was open or the conversation was
  compacting could stall for many seconds, or be pushed past the open card.
  Question cards are never bypassed or dropped by steering: such messages wait
  and steer in once the card is answered.
- **Stop now really stops** when steered messages were already pushed into the
  turn. The Claude CLI otherwise opened a follow-up turn for them that re-ran
  the stopped tool call; those messages now show *Stopped with the turn — not
  answered* with **Resend** instead of claiming they were handled. A stopped
  message is also no longer re-run if its worker dies right after the Stop.
- After a reload, a message sent after a folded steer is no longer styled as
  steered with its reply merged into the previous turn, and older replies stay
  anchored under their own messages.
- The live reply bubble no longer carries over into another conversation or
  drops below later steered messages, and the live bubble and **Stop** follow
  the turn that is actually producing output. A finished background task's
  answer is no longer lost when a queued message takes over the turn.
- A screenshot-only send no longer vanishes from the transcript before its
  message lands.
- Sidebar filter: keeps searching older pages while the list is busy loading,
  matches accented titles regardless of how they were typed, no longer zooms
  the page on iOS, and announces the match count once to screen readers
  (saying when only loaded conversations were searched).
- A background agent's failure no longer vanishes: a Copilot follow-up turn
  that carries the failure line, but has nothing else to show, keeps its row.
- The **Background task timeout** slider no longer reads *No limit* while the
  settings load; it starts at the 4-hour default.
- Settings calls the SDK engine the Copilot default (it still read
  *experimental*, with Extension as *current*), and the background task
  timeout help names Copilot's background agents and shells.
- `oar` probed a different port than the one it started the relay on when the
  config's `port` was not 3333 or differed from `--port`, then killed the relay
  it had just started after 20 seconds. It now uses one port: `--port` for that
  run, else the config's. `--help` no longer lists `--token`, which the
  launcher never read.
- Concurrent conversation deletes could start extra Copilot runtimes that were
  never shut down.
- Question cards said *Copilot question* in every conversation; they now name
  the runtime that asks (Claude, Copilot, Cursor, OpenAI).

## [0.9.2] — 2026-09-13

### Added

- **Opt-in self-update**: a settings toggle for automatic update checks (off by
  default; the relay never contacts oar.sh unless you opt in), plus a manual
  check button. `OAR_NO_UPDATE_CHECK=1` disables even manual checks.
- Agents can embed **images, video and audio inline** in replies by bare
  absolute path, on every provider. Clicking an embedded image opens the file
  viewer with zoom, download and copy.
- **Screenshot annotations**: mark up uploaded screenshots with highlighter
  strokes before (or after) sending; the original upload is never modified.
- A **Features** settings tab; feature flags now live in the database (the
  `config.json` `features` key is migrated once and removed; env vars still win).
- Windows **system-startup autostart** mode (a boot-triggered scheduled task,
  one UAC confirmation) alongside the existing at-sign-in mode.
- `config.json` can carry the data directory.

### Changed

- New Copilot conversations default to the **SDK engine** when the relay can
  run it, falling back to the CLI extension otherwise; an explicitly stored
  setting always wins.
- The Copilot model catalog shows each model's real reasoning efforts and
  context window, in a canonical order.
- Model labels are compact enough for phone composers (`Fable 5.1`,
  `Haiku 4.5`), and the composer placeholder names the selected model's family.
- Claude models stay in the picker when Anthropic rotates the advertised
  lineup; `@anthropic-ai/claude-agent-sdk` 0.3.261 (Fable 5.1 model floor).
- Global installs run from the OAR state root, so self-update can replace the
  package directory on Windows.
- Transient relay notices render as an opaque toast instead of bleeding
  through modals.

### Fixed

- A custom PWA app name no longer reverts on Android: the relay serves it in
  the manifest instead of a browser-local override.
- Queue writes are fenced to one processing attempt, so a superseded delivery
  can no longer overwrite a settled message.
- Live-bubble rendering: cross-conversation teardown, muted streams after
  enqueue, a live-poll deadlock and anchor theft.
- A queued send's own text no longer reappears in the composer.
- Copilot turns ending in a bare `task_complete` tool call show the real
  summary instead of a cut-off fragment; detached Copilot shells appear as
  background-task cards.
- Copilot worker and server-side session ownership hardening (continuations,
  questions, shutdown, rekeying, worker kill verification).

## [0.9.1] — 2026-09-02

### Fixed

- The globally installed `oar` command silently did nothing: npm's bin symlink
  names `argv[1]` plain `oar`, which the `oar.js` entrypoint check never
  matched. The guard now resolves real paths (and ships the executable bit).

## [0.9.0] — 2026-09-02

### Changed

- **The project is now OAR — Open Agent Relay** (`@oar-sh/oar`, binary `oar`,
  home at [oar.sh](https://oar.sh)). It began life as `copilot-remote` and has
  long outgrown the name: one relay now drives Copilot (CLI extension or SDK
  engine), Claude (Agent SDK), Cursor, Grok, and OpenAI BYOK.
- Global installs keep their state in `~/.oar` (`%APPDATA%\oar` on Windows) so
  `npm i -g` updates can never touch the database. Existing state from a git
  checkout or the legacy managed config dir is migrated in once, copy-never-move,
  with WAL checkpointing and integrity verification; the old tree is left behind
  as the rollback path. Git checkouts keep their repo-local layout unchanged.
- The published npm package now contains only the runtime (an explicit `files`
  allowlist); tests, docs, and screenshots stay in the repo.

### Added

- `oar --migrate-from <old-checkout>` imports relay state from a pre-rename
  checkout into `~/.oar`.
