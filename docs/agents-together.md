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

**What agents can do.** Every provider gets the same `remote_relay` tool (Claude, Cursor and
Copilot directly; Grok and the Copilot extension engine through OAR's MCP server). Sessions get it
while at least one relay is paired or [agent sessions](#agent-sessions) are switched on. Per paired
relay, **Agents may** limits it to *read only*, *read and prompt* (existing sessions) or *full*
(also create sessions, answer questions, stop turns, archive). In the *ask* and *plan* relay
modes, every write action first asks you with a question card. For a session it starts, an agent
can set the provider, model, relay mode and reasoning effort; what it leaves out follows the
session it works in, as far as the other relay offers it. A model the provider does not list there
(the list New Chat offers) is refused before anything is created or sent, with the close matches
("Unknown model 'gpt-5-4' for Copilot on relay …; did you mean 'gpt-5.4'?"); for Claude, `opus`, `sonnet` and
`haiku` stand for the newest listed model of that name, and a Copilot model named with its effort
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
it is in (agents only read groups; they do not change them).
`read_task_output` returns the tail of a shell or monitor task's output on a relay (up to 500
lines), how many minutes it has been quiet, and the pass/fail counts when the output is a known
test runner's; secrets are blanked, as in the owner's console view. Share links never expose it.

A `send`, `create_session` or `wait` call waits for the reply for as long as the agent asks, up to
**Longest wait per tool call** of the relay the agent runs on (10 minutes unless you changed it,
see [Agent sessions](#agent-sessions)). When the time is up the agent gets what there is so far
and can call `wait` again.

When an agent prompts a session on another relay, that relay shows a **↗ from …** badge with the
sending relay, session and model on the message, and marks sessions an agent created in the
conversation list. The remote agent sees a one-line header saying that another agent is talking
to it. In the transcript, a message from another agent (on a paired relay or on this one) folds
into one row ("note from … · answered below") that opens to the full text; the session's reply
always shows, like a reply to you. Turns started this way do not send "reply ready"
notifications on the remote relay; question cards still do. **Accept prompts from other relays' agents** in **Settings → Relays**
switches incoming agent prompts off.

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
  sessions on this relay.
- **Not on itself.** An agent cannot prompt, stop, archive, wait for or answer the conversation
  it runs in.
- The count of 30 prompts without a message from you (see above) includes prompts to sessions
  on this relay.

**What it can start.** A session with any provider that is enabled on this relay (Copilot,
OpenAI, Claude, Cursor, Grok or Claude Cloud; not an OpenAI Image chat): in a folder
(the relay's default folder when the agent names none), or a [Claude Cloud](providers.md#claude-cloud) chat
with `provider: "claude-cloud"`, `repo` and an optional `branch`. A new session knows nothing of
the conversation it was started from. Sessions an agent starts use this relay's accounts and
count against their usage.

**In the conversation list.** A session an agent on this relay started carries **via agent ·
“title”** in the sidebar and under the title in the header, with the title of the conversation
the agent runs in; clicking it opens that conversation while it is still in the list. The
agent's prompts carry the same marker, with its model, as a badge on the message. The session
sits in a [group](web-ui.md#session-groups) under the conversation that started it. The relay
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

**What wakes it.** A question waiting for an answer (with its options), an error (a failed turn,
the usage limit, a worker that died), a reply (with a preview), a background agent that finished,
a background agent or shell task that failed (a shell command that exits non-zero counts), a
session that went quiet while working (15 minutes by default), and the moment nothing runs any
more in the watched sessions. A shell command that ended well wakes the watcher only when it asks
for every task end (`task_finished` in `events`, with `task_started` for the starts): a busy session
runs many, and each would cost the watcher a turn. A subscription names sessions, or `all`
for every session, later ones included; the watcher's own conversation is never watched. It can
filter replies and task results by a regular expression, end after it fired once, and add a
heartbeat while work runs.

Subscriptions made before this default changed without naming events get the new default by
themselves; those that named their events keep them. A paired relay that runs an older OAR applies its own
default and refuses `subagent_finished` by name.

**What it looks like.** OAR writes a short message into the watcher's conversation: a new turn
when the watcher is idle, a steer into the running turn on Claude and Copilot's SDK engine, the
next turn otherwise. The message says it is automated, not from you, and that it approves
nothing; it shows as a compact row, never as one of your messages. Events within 30 seconds come
as one message; past 20 wake-ups an hour the rest comes as a digest every ten minutes, while
questions and errors still come at once.

**What it may do.** A subscription only notifies. It approves nothing and answers
nothing; what an event asks for is decided as before, by you or by the agent within what
it may do anyway. The first subscribe of a conversation, and any to `all`, asks you on an approval
card naming the sessions (and the relay); `transfer_subscriptions`, which hands every subscription
of an old watcher to a new one, always asks.

**Where you see it.** The watcher's header shows **watching N sessions**; the chip opens the list
of its subscriptions with an **Unsubscribe** button each. A watched session shows a **watched**
badge.

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
