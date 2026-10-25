# Agents working together

Agents that reach other relays, start sessions of their own, and watch other sessions, with you in control. This is the detail behind the [README](../README.md#agents-working-together); the most complete guide is [Agents together on oar.sh](https://oar.sh/docs/agents-together/).

## Remote relays

*On oar.sh: [Remote relays](https://oar.sh/docs/agents-together/remote-relays/)*

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

**What agents can do.** Every provider gets the same `remote_relay` tool (Claude, DeepSeek, Cursor
and Copilot directly; Grok and the Copilot extension engine through OAR's MCP server). Sessions get it
while at least one relay is paired or [agent sessions](#agent-sessions) are switched on. Per paired
relay, **Agents may** limits it to *read only*, *read and prompt* (existing sessions) or *full*
(also create sessions, change their settings, answer questions, stop turns, archive). In the *ask* and *plan* relay
modes, every write action first asks you with a question card. For a session it starts, an agent
can set the provider, model, relay mode and reasoning effort; what it leaves out follows the
session it works in, as far as the other relay offers it. A `send` that names no model or effort
keeps the ones the session there uses. A model in `create_session` or `send` that the provider
does not list there (the list New Chat offers) is refused before anything is created or sent,
with the close matches ("Unknown model 'gpt-5-4' for Copilot on relay …; did you mean 'gpt-5.4'?"); for
Claude, `opus`, `sonnet` and `haiku` stand for the newest listed model of that name, and a Copilot model named with its effort
(`gpt-5.4-high`) runs as that model with that effort. When the relay has no list for the
provider yet (its model discovery has not run), the model is passed on unchecked and the answer
says so. A [Claude Cloud](providers.md#claude-cloud) session
is started with `provider: "claude-cloud"`, a `repo` (a GitHub URL or `owner/repo`, for example
`example-org/sample-repo`) and an optional `branch` instead of a folder; without a model it gets
the default model of the other relay's Claude Cloud tab. Claude Cloud must be switched on there.
A cloud session that exists can be read, prompted, waited for and stopped like any other.

Two read actions help an agent plan: `usage` says what each provider's plan has left on a relay
(Cursor's spend against its limit, Claude's windows and whether a usage limit has paused turns,
Copilot and Grok where they are tracked; never account names, addresses or tokens), and
`list_sessions` / `read_session` give each session's `state` (`running_turn`, `background_only` or
`idle`) with its background agents and shell tasks, and the [session group](web-ui.md#session-groups)
it is in. An agent can name an existing group (`group`, an id or name `relay_info` lists) when it
creates a session, here or on a paired relay; an unknown group is refused and nothing is created.
Renaming, dissolving and rearranging groups stays yours.

**Changing another session's settings.** With `update_session` an agent sets another session's
model, reasoning effort, relay mode, auto-compact window, title, group, thinking or working folder for
its next turns, without prompting it, and gets back the settings and what changed. The checks are those
of `send` (an unknown model is refused with the close matches); a group name that does not exist yet
makes a new group, and `"none"` takes the session out of its group. A group you made is never removed
this way: when an agent takes out its last session, the group stays, shown empty in your sidebar (rename
or dissolve it from its menu; nothing removes it by itself), and agents can name it again. A group an
agent made, by name or by starting sessions, goes once it is empty. A new folder restarts the session's CLI there and is
refused while a turn or a background task runs. A mode set this way lasts until the next `send` that
names another mode or comes from a caller in another mode (a `send` without a mode passes the caller's
own). An agent may change freely only a session its own conversation started (here, or on a paired
relay when that relay recorded this conversation as the starter). Any other session, yours, another
agent's or the one that started the agent, needs your **Allow** first: a question card, once per
conversation and relay, that covers that conversation's later changes to such sessions there; **Deny**
refuses the call. If a step fails after others were written, the answer lists in `changed` what was
written. An agent never changes the conversation it runs in, nor the switch that lets a session's agents
start sessions (see [the rules](#agent-sessions) below).

`read_task_output` returns the tail of a shell or monitor task's output on a relay (up to 500
lines), how many minutes it has been quiet, and the pass/fail counts when the output is a known
test runner's; secrets are blanked, as in the owner's console view. Share links never expose it.

A `send`, `create_session` or `wait` call waits for the reply for as long as the agent asks, up to
**Longest wait per tool call** of the relay the agent runs on (10 minutes unless you changed it,
see [Agent sessions](#agent-sessions)). When the time is up the agent gets what there is so far
and can call `wait` again.

An argument an action does not take is never dropped without a word. `create_session` and
`update_session` refuse the call, list the arguments they take, and change nothing; every other action still runs and
names the arguments it did not take in `ignored: [...]`.

When an agent prompts a session on another relay, that relay shows a **↗ from …** badge with the
sending relay, session and model on the message, and marks sessions an agent created in the
conversation list. The remote agent sees a one-line header saying that another agent is talking
to it. In the transcript, a message from another agent (on a paired relay or on this one) folds
into one row ("note from … · answered below") that opens to the full text; the session's reply
always shows, like a reply to you. A turn that an agent started, from a paired relay or from
this one, sends no "reply ready" or "failed" push notification: the agent waits for the reply
and reports back itself. Question cards still notify.

**Accept prompts from other relays' agents** in **Settings → Relays** (on by default) leaves
other relays' agents only reading when you switch it off. They are then refused when they prompt
a session, start one, answer a question, stop a turn, cancel a queued message, archive or
unarchive a session, subscribe to sessions here, or fetch the events of a subscription. So a
paired relay that [watches sessions](#watching-sessions) here gets no events while it is off;
this relay keeps them, as during an outage, and delivers them once the switch is on again.
Listing and reading sessions, a task's output, `wait`, `relay_info` and `usage` still work. This
relay's own agents ([agent sessions](#agent-sessions)) are not affected.

The calls go through your own relay, which holds the other relay's token: agents never see a
token. Remote addresses must use `https://`; plain `http://` is accepted only for loopback (an
SSH port forward, for example) and private network ranges.

## Agent sessions

*On oar.sh: [Agent sessions](https://oar.sh/docs/agents-together/agent-sessions/)*

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
  sessions on this relay, unless you allow it for that session: **Agents in this conversation may start
  sessions** in its 🧠 settings (shown for sessions an agent started). The other rules still apply to it,
  and no agent can set this switch.
- **Not on itself.** An agent cannot prompt, stop, archive, wait for, answer or change the settings of
  the conversation it runs in.
- The count of 30 prompts without a message from you (see above) includes prompts to sessions
  on this relay.

**What it can start.** A session with any provider that is enabled on this relay (Copilot,
OpenAI, Claude, Cursor, Grok, DeepSeek or Claude Cloud; not an OpenAI Image chat): in a folder
(the relay's default folder when the agent names none), or a [Claude Cloud](providers.md#claude-cloud) chat
with `provider: "claude-cloud"`, `repo` and an optional `branch`. A new session knows nothing of
the conversation it was started from. Sessions an agent starts use this relay's accounts and
count against their usage.

**In the conversation list.** A session an agent on this relay started carries **via agent ·
“title”** in the sidebar and under the title in the header, with the title of the conversation
the agent runs in; clicking it opens that conversation while it is still in the list. The
agent's prompts carry the same marker, with its model, as a badge on the message. The session
sits in a [group](web-ui.md#session-groups) under the conversation that started it, or in the
group the agent named. The relay
never archives these sessions by itself: they stay in the list until you archive or delete them,
or the agent archives one with the tool.

**Longest wait per tool call.** The slider under the switch sets how long one `send`,
`create_session` or `wait` call may wait for a reply: 10 minutes by default, from 2 to 60 minutes
in steps of one minute. The agent can call `wait` again to keep waiting. The limit also applies
to this relay's agents when they wait for a session on a paired relay, so the slider can be moved
whether or not the switch above it is on. A turn that waits is still subject to **Max turn duration**
under **General** (60 minutes by default), which does not know about the wait.

## Watching sessions

*On oar.sh: [Watching sessions](https://oar.sh/docs/agents-together/watching-sessions/)*

An agent can watch other sessions instead of polling them: with `remote_relay`'s `subscribe` it
asks to be woken when something happens there. It works for every provider, on this relay (with
[agent sessions](#agent-sessions) switched on) and on a paired one.

**What wakes it.** A question waiting for an answer (with its options, and later your answer when
it was asked with [ask](#questions-that-dont-block)), an error (a failed turn,
the usage limit, a worker that died), a reply (with a preview), a background agent that finished,
a background agent or shell task that failed (a shell command that exits non-zero counts), a
session that went quiet while working (15 minutes by default), and the moment nothing runs any
more in the watched sessions. A shell command that ended well wakes the watcher only when it asks
for every task end (`task_finished` in `events`, with `task_started` for the starts): a busy session
runs many, and each would cost the watcher a turn. A subscription names sessions, or `all`
for every session, later ones included; the watcher's own conversation is never watched. It can
filter replies and task results by a regular expression, end after it fired once, and add a
heartbeat while work runs.

**After a relay restart.** An agent can also ask to be woken when this relay runs again, after a
restart, an update, a crash or a host reboot: `relay_restarted` in `events`, with no sessions
needed. It is never part of the default; only an agent that names it is woken. An agent that is
about to restart the relay subscribes to it with `once` first, so it goes on with its work when the
relay is back even if the timers its CLI had scheduled did not survive. The message says when the
relay came back and how it stopped: who requested the restart, when and why, or that the relay
did not record how it stopped (for example a crash, a forced stop or a reboot; on Windows an
ordinary stop by the supervisor may read like that too). Each start wakes such a subscription
once. A restart requested while a turn that such a message woke is still running does not wake
that conversation, whoever asked for it, so restarts cannot chain into a loop; the message says so,
and a `once` subscription held back this way ends. This one needs no approval card when it names no
sessions (it watches no session), and it is for this relay only.

Subscriptions made before this default changed without naming events get the new default by
themselves; those that named their events keep them. A paired relay that runs an older OAR applies its own
default and refuses `subagent_finished` by name.

**What it looks like.** OAR writes a short message into the watcher's conversation: a new turn
when the watcher is idle, a steer into the running turn on Claude and Copilot's SDK engine, the
next turn otherwise. The message says it is automated, not from you, and that it approves
nothing; it shows as a compact row, never as one of your messages. Events within 30 seconds come
as one message; past 20 wake-ups an hour the rest comes as a digest every ten minutes, while
questions and errors still come at once.

**Fewer wake-ups.** Every wake-up is a full turn of the watcher, so a subscription can ask for
fewer. Questions and errors are never held back by any of these.

- **Digest** (`digest_minutes`, 1 to 1440): the subscription's other events are gathered and come
  as one message every N minutes, the next one N minutes after the last at the earliest.
- **Quiet hours** (`quiet_hours`, for example `{"from":"23:00","to":"06:00","tz":"Europe/Berlin"}`):
  a daily window in a time zone, which may run past midnight and follows the clock changes.
  What happens inside it waits and comes as one message, marked as held during quiet hours, when
  the window ends. No heartbeat is sent inside it. On the night the clocks go back and the end
  time comes twice, the window ends the first time and is not entered again in the repeated hour;
  on the night they go forward and skip the end time, it ends the moment they jump. One limit: a
  start time inside the repeated hour starts the window on the first pass, and on the second pass
  the minutes before the start time count as outside it.
- **Leaving sessions out** (`exclude`, up to 50 session ids): a subscription to `all` sessions
  ignores these, also for "nothing runs any more" and the heartbeat.
- **No echo of its own replies:** when the watcher prompts a session itself with `send` or
  `create_session` and gets the finished reply back from that call or a later `wait`, that turn's
  reply does not wake it a second time. Its errors and questions still do, and a prompt it did not
  wait for (`wait_seconds: 0` and no `wait`) wakes it as before.

Held events survive a restart. The 20-an-hour limit still applies on top. `list_subscriptions`
shows the options, how many events each subscription holds (`heldCount`) and when they are due
(`nextDeliveryAt`). On a paired relay, the digest and quiet hours are applied here, where the
watcher is; the other relay is told which sessions are left out. A paired relay that runs an older
OAR does not know `exclude`: this relay still drops the events of those sessions, but that relay
counts them for "nothing runs any more", for stalls and in the heartbeat's list. What a paired
relay kept while the link was down keeps to the digest and quiet hours like any other event.

**What it may do.** A subscription only notifies. It approves nothing and answers
nothing; what an event asks for is decided as before, by you or by the agent within what
it may do anyway. A conversation's first subscribe to sessions of a relay asks you on an approval
card naming the sessions (and the relay), and so does its first subscribe to `all` sessions of
that relay; **Allow** covers the later ones there. The approval is per relay: subscribing to
sessions of another relay asks again. `transfer_subscriptions`, which hands every subscription
of an old watcher to a new one, always asks.

**Where you see it.** The watcher's header shows **watching N sessions** (**waiting for a relay
restart** when it only asked for `relay_restarted`), with a small **digest N min** or **quiet
HH:MM–HH:MM** beside it where a subscription has one; the chip opens the list of its
subscriptions with an **Unsubscribe** button each. A watched session shows a **watched** badge.

**Lifetime.** Subscriptions survive a restart and end on unsubscribe, when the watcher or the
watched session is archived, after firing once (`once`), or, for a paired relay, when the pairing
is removed.

**On a paired relay** the relay must be unlocked in the conversation and allow at least reading,
and the other relay must accept other relays' agents; nothing is asked there. This relay fetches
the events every few seconds over the pairing (a pairing in one direction is enough), and their
lines start with the other relay's name. If the link drops, the other relay keeps what happens
(up to 500 events per subscription, for 7 days) and delivers it as one row tagged **replayed** once
it answers again, questions and errors first, between "link lost" and "link restored". A relay
that runs an older OAR answers that it needs an update.

## Scheduled prompts

An agent can ask this relay to send it a prompt later, once or again and again, with
`remote_relay`'s `schedule`: a time (`at`, with a time zone), an interval (`every_minutes`, 5
minutes to 7 days), or both (the first time, then the interval). A nightly review, a sweep every
half hour or a check in an hour keep going after a restart or an update, which the timers of the
agent's own CLI do not. A time missed while the relay was down is made up once when it is back,
not once per missed interval, and a repeat waits while the prompt before it is still queued.

Schedules need **Agents may start and use sessions on this relay** (Settings → Relays → Agent
sessions) to be on, even for an agent's own conversation. The prompt goes to the agent's own
conversation, or to another session on this relay. For another session the agent needs the same
approval as for a prompt it sends there (the card in ask and plan mode), and the schedule counts
like such a prompt: setting it, and each time it fires. Past the number of prompts an agent may
send other agents before you write, it is held (**waiting until you write in …** in the list) and
goes once you have written in the conversation that set it. The message starts with
**[relay schedule …]**, names the schedule, says it is automated, not from you, and that it
approves nothing; it comes in as the next message, never folded into a running turn as yours. The
turn it starts runs in the target session's own mode (agent, ask, plan or autopilot), not the
mode of the session that set it. It keeps where the prompt behind it came from, so a schedule
never lets a chain of agents across relays go further than a direct prompt could.

A conversation that has schedules, or set them, shows **⏰ N scheduled** in its header; the chip
lists them with a **Cancel** button each. A session a schedule fires into shows **scheduled** in
the sidebar. An agent lists its schedules with `list_schedules` and ends one with `unschedule`.
Archiving a session ends the schedules that fire into it and the ones it set; compacting it moves
them to the new conversation. A conversation holds at most 20. Schedules live on the relay that runs the session; a paired relay keeps its own.

## Questions that don't block

An agent's own question tool (`ask_user`, a card the session waits on) stops its work until you
answer. With `remote_relay`'s `ask` an agent asks you instead and goes on working on whatever does
not depend on the answer: the question shows as a card in its session, and in the **Inbox**, but
the session does not wait. When you answer or dismiss it, the agent is told at once, as a relay
event (`question_answered`, with your answer and the option you picked, or that you dismissed it, and the relay you answered on).
It needs no subscription, and no setting either for an agent's own session.

An ask has a question (at most 500 characters), up to eight options shown as buttons, the agent's
recommendation (one of the options, marked, or free text), a detail shown folded (at most 2000
characters), and an urgency: `now` also sends a push notification, `normal` (the default) does not.
You may always type an answer of your own instead of picking an option. A conversation has at most
20 asks pending. The agent can list its asks (`list_questions`) and take one back (`withdraw`).

**On behalf of another session.** A lead can ask for a session it works with, on this relay (with
[agent sessions](#agent-sessions) switched on) or on a paired relay (where its permission must be
at least **prompt**). Like a prompt to that session, it needs your Allow first when the lead runs in
ask or plan mode. The card then shows in that session, and both it and the lead are told the
answer. An ask about a session on a paired relay is kept on that relay, where the session lives;
this relay looks for the answer there every few seconds while the ask is open.

**The answer is yours.** The relay event that carries it is automated, like every relay event, and
approves nothing else, but its answer is your own reply to that question. It never counts as your
message for the limit on how many prompts agents may send each other before you write: answering
an ask does not let agents go on longer without you. No agent can answer an ask, not with
`answer_question` either: only you can, in its session or an Inbox (this relay's, or that of a
relay paired with it).

### The Inbox

**Inbox** in the sidebar, with the number of questions waiting, lists every pending question in
one place: the asks, and the cards sessions wait on (questions and approval cards), on this relay
and on every paired relay that answers. They are grouped by relay, newest first, each with its
session (a link that opens it), its age and its relay. **Mine** narrows the list to the sessions
you started, **Agents** to the ones an agent started. What you answered or dismissed stays for a
day under a divider.

You answer an ask here as in its session: an option, typed text, or **Dismiss**. That holds for
an ask on a paired relay too: the answer goes there through the pairing. A card a session on this
relay waits on is answered here as well (a card with several fields or several picks opens its
session instead). A paired relay's cards, its approval cards above all, are answered only on that
relay: the Inbox shows them with **Open there**. The pairing carries answers to asks only, never
to a card, so a relay you paired with can never approve anything here.

Everything an ask shows was written by an agent, maybe on another relay: the Inbox shows it as
plain text, never as formatting or links. On a phone it is one column with full-width buttons.
