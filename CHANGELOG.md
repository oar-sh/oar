# Changelog

All notable changes to OAR are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

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

### Changed

- **Claude Cloud: an expired Claude login is refreshed before a chat gives
  up.** The Claude CLI's login lasts eight hours and is refreshed only when
  the CLI runs; a cloud chat used after a quiet night found an expired token
  and asked you to log in again. The cloud worker now asks the relay to run
  the CLI's own status probe first (which refreshes a login whose refresh
  token is still good), reads the login again and retries; the "log in
  again" note comes only when that did not help. OAR still never uses the
  refresh token itself.
- **Claude Cloud: a turn refused at the usage limit is paused, not failed.**
  A cloud chat now pauses at the Claude usage limit the way a local Claude
  chat does: the row ends with a note naming the reset time, the banner
  shows the pause, and the work carries on by itself after the reset (or
  waits for **Resume now**). Before, the limit was one line in the tool
  activity and the turn failed.
- **Check Usage opens at once.** The modal shows the reading it showed last
  time immediately and reads only the open tab's provider live (the card says
  "updating…" meanwhile), instead of fetching every provider and showing a
  spinner until the slowest answered. A tab you switch to is read live when
  its reading is older than a minute; **Refresh** reads the open tab only.
  The relay keeps the last live answer of every provider, so the other cards
  stay filled (`GET /api/usage?providers=…`).

### Added

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
- **Claude Cloud: chats that run in a sandbox at Anthropic.** A new provider,
  off by default. A Claude Cloud chat runs Claude Code in Anthropic's cloud,
  on its own clone of a GitHub repository instead of on the relay host. It is
  billed to the Claude account the host's Claude CLI is logged in to, and its
  results come back as branches the agent pushes. Switch it on in Settings →
  Providers → Claude Cloud and choose the cloud environment and a default
  model there; it needs the Claude CLI logged in with a claude.ai account on
  the relay host, GitHub connected to that account, and the Claude GitHub app
  allowed on the repository. New Chat → Claude Cloud fills **Repository** and
  **Branch** from the folder you pick, offers the repositories the Claude
  GitHub app can reach (the ones used here before first) and the branches of
  the picked repository as suggestions, lets you type both, and warns about
  commits that are not pushed, changes that are not committed and a
  repository the app cannot reach. In the chat
  the reply streams in live, the agent's questions and permission prompts
  arrive as cards, **Stop** interrupts the turn, and images can be attached.
  A line above the composer links the session on claude.ai and every branch
  the agent pushed to its comparison on GitHub, and shows the cost so far. A
  follow-up goes into the same session, also after it has been idle; a
  restart in the middle of a turn picks the turn up again instead of sending
  your message twice; deleting or archiving the chat archives the cloud
  session. Not there: relay modes, a reasoning effort, steering during a
  turn, files other than images and anything else from the relay host, and
  the relay's tools and previews inside the sandbox. **Before you switch it
  on:**
  the provider uses the Claude CLI's stored login to call the Anthropic API
  endpoints the CLI itself uses. These are not a documented public API and
  may change. OAR only reads the token: it never stores, logs or refreshes
  it, and sends it nowhere but to Anthropic. While the provider is off the
  relay fetches nothing with that login, except for cloud chats you created
  before. See "Claude Cloud" in the README.
  When the cloud agent hands work to a subagent in the background and
  pauses, the turn stays open and the reply is what the agent says once that
  work is done.
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

### Fixed

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

### Changed

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
