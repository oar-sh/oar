# Changelog

All notable changes to OAR are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

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

### Changed

- The background task panel scrolls when it holds more tasks than fit,
  instead of growing past the window — in phone landscape too, where the
  composer now always stays on screen.
- Rotating a phone to landscape keeps the portrait text size instead of
  jumping to the larger desktop size.

- The composer's send button no longer turns into **Stop** while a turn runs.
  It reads **Steer** when a Claude turn is live and text is drafted, and stays
  disabled on an empty composer. While steering is held (open question card or
  plan approval, compaction) it stays enabled and reads **Queue**, with the
  reason in its tooltip: the message waits as an ordinary pending bubble (with
  **Cancel**) and steers into the turn once the card is answered or the
  compaction ends. Stopping lives where the work is: the running reply's bubble
  carries **Stop**, and queued messages carry **Cancel** until they are picked
  up.
- Queued messages are claimed strictly in send order, including messages that
  went through a delivery retry. Previously a retried message could starve
  behind newer ones for minutes in an active conversation, or run after them
  so replies arrived out of order.
- `@anthropic-ai/claude-agent-sdk` 0.3.281 (bundled Claude Code 2.1.281),
  which makes **Claude Opus 5.5** (`claude-opus-5-5`, plus its 1M-context
  variant) discoverable. Model discovery runs the SDK's bundled CLI, so
  `claude update` alone never surfaces a new Claude model.
- `@github/copilot-sdk` 1.0.14: typed message provenance (human vs. system vs.
  agent senders), a `fast` auto-routing tier, a `managedSettings.clearCache`
  RPC, and streaming-throughput fixes.

### Fixed

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
