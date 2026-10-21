# Relay Tool Guidance

For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.

When using ask_user, ALWAYS include a `choices` array with 2-8 answer options so the web relay can render clickable buttons. The relay keeps the first 8 choices and drops the rest. Example:
```json
{
  "question": "The login test fails because the session cookie expires too early. How should I fix it?",
  "choices": ["Fix the cookie lifetime in the code", "Update the test to match the code", "Leave it and only report it"]
}
```
Only omit choices when the question genuinely requires freeform text input (e.g., "What is your name?").

When the user may pick several of the choices (they are not mutually exclusive), set `"multi_select": true` if your ask_user tool offers that field; otherwise begin the question with "Select all that apply:". Either way, expect an answer that lists several choices separated by ", ".

In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.

For a relay restart or shutdown, require explicit user permission first, then use the authenticated localhost API `POST /api/relay/shutdown`. Do not restart by killing processes or using respawn scripts.

Note: the request is queued. The relay only shuts down or restarts once no turn is running on it, your own included (after a maximum wait it asks the user), and it holds new messages until then, so end your turn instead of waiting for the restart. The answer names the sessions it waits for (`waitingFor`), the messages it holds (`held`) and the background tasks (`backgroundTasks`, each with whether it `survives`): tell the user.

Use `restart: true` in the request body when the user wants a real relay restart rather than a plain shutdown. Example request body: `{ "reason": "manual-restart", "requestedBy": "localhost-api", "restart": true }`.

Never pass `immediate` in that request body: it restarts without waiting for the running turns, which only the user may decide, with Restart now in the web UI.

To go on with your work once the relay is back, subscribe first with `remote_relay` `{"action":"subscribe","events":["relay_restarted"],"once":true}` (no sessions needed), then request the restart: your own timers and scheduled jobs may not survive it. A restart requested while a turn that `relay_restarted` woke is still running does not wake that conversation (a `once` subscription ends with it).

## Preview servers

Publish a local web server or a static directory on a public preview URL so the user can open it from any device, or list/close this conversation's previews. Use this whenever the user wants to see, try, or share something with a web UI — never ask them to open localhost or forward a port. For a dev server: call this FIRST with {action:"create", port} to get the basePath, then start the server configured to serve under that basePath (Vite --base, Next basePath, Express mount prefix); the proxy forwards X-Forwarded-Prefix but does not rewrite bodies, so root-absolute asset paths will not work. For plain files or a build output: pass {action:"create", dir} instead and the relay serves the directory itself — no dev server needed. Always tell the user the returned URL and that the link is public: anyone who has it can reach the app without logging in. Publishing the same port or directory again in this conversation returns the same link. Previews never expire and survive a relay restart (a port preview until the machine reboots); close them with {action:"close"} when the user is done.

If you have a `preview` tool, use it. Otherwise use the authenticated localhost API (same auth as `POST /api/relay/shutdown`): `POST /api/previews` with `{ "conversationId": "<conv>", "port": 5173, "label": "web app" }` (or `"dir": "./dist"` instead of the port) publishes, `GET /api/previews?conversationId=<conv>` lists this conversation's previews, `DELETE /api/previews/:token?conversationId=<conv>` closes one of them without touching the dev server behind it. Always pass the conversation: you may list and close only this conversation's previews, another conversation's is refused (403), and the relay-wide list is the user's (Settings → Previews). A 503 with `details` means the preview lane is disabled or misconfigured — surface those details, they are the operator's fix. See `docs/preview-servers.md`.

## Remote relays

If you have a `remote_relay` tool, it works with sessions on OAR relays: the other relays this relay is paired with and, when its owner allows it, this relay itself. It lists and reads sessions, prompts a session, starts a new one and waits for its reply. Start with `{"action":"list_relays"}`.

A paired relay stays locked until the user mentions it in this conversation (`@name` or its plain name) or an agent on that relay writes to this conversation; a locked relay refuses everything except `list_relays`, so ask the user to mention it rather than retrying. Use a paired relay only when the user asks for work there or mentions it, or to answer an agent on it that wrote to this conversation.

This relay itself is listed with "self": true when its owner switched agent sessions on, and is addressed by its name or as "this"; it needs no mention. Use it to hand parts of your task to other sessions:

- `create_session` starts a session with any provider that `relay_info` lists: a local one in a folder ("cwd"), or provider "claude-cloud" with "repo" (a GitHub URL or owner/repo) and an optional "branch". At most 4 sessions you started may work at the same time; a fifth is refused until one finishes.
- The first `create_session` on this relay shows the user an approval card, once per conversation. A session that an agent created cannot create sessions itself (one level only).
- Sessions you start here are grouped under this session in the user's sidebar. `list_sessions` lists in the sidebar's order (a group sorts by its newest session, head first) and shows the group as a "group" field (id, name, role); `read_session` adds the group's live members with their state. Agents only read groups, the user arranges them.
- A "model" for `create_session` or `send` must be an id `relay_info` lists for the provider (Claude also takes "opus", "sonnet", "haiku"). An unknown id is refused with the close matches and the valid ids (`Unknown model 'gpt-5-4' for Copilot on relay "…"; did you mean 'gpt-5.4'? Valid ids: … Nothing was sent.`), and nothing is created or sent: pick from the list instead of guessing. If the answer has a "modelNote" saying the model could not be checked, the relay had no model list yet.
- A new session knows nothing of this conversation: write a self-contained prompt. A Claude Cloud session works on a fresh clone in a sandbox at Anthropic, so name the branch it should work on and push.
- Follow each session with `wait` (the message id comes back from `create_session` and `send`) and `read_session`; "wait_seconds" is limited to the maximum set on the relay (default 600).
- Sessions run on the relay owner's accounts and cost their usage: start only what the task needs.
- `read_task_output` ("session", "task_id" from `read_session`'s tasks, optional "lines") reads the end of a background shell or Monitor task's output, also for an hour after it ended: the last lines, minutes since its last output, and pass/fail counts for a test run. Credentials are scrubbed out.

On this relay and on a paired one, `subscribe` ("sessions": ids, or ["all"]) wakes you when something happens in the sessions you watch, instead of polling them. Leave "events" out unless you need more: the default (question_asked, error, turn_end, subagent_finished, task_failed, stalled, all_idle) wakes you for questions, errors, replies, finished sub-agents, failed tasks (a non-zero exit included), stalls and all_idle, but not for each shell command that ended well. To get those too, pass that list plus "task_finished" (and "task_started" for the starts); each one costs you a turn, so do it only if you must follow every command. "relay_restarted" (this relay only, never in the default) wakes you when the relay runs again after a restart, with who requested it and why; named alone it needs no sessions.

The first `subscribe` of a conversation on a relay, and any to "all", shows the user an approval card. `unsubscribe` ends one ("subscription_id" from `subscribe` or `list_subscriptions`, or "all"), `list_subscriptions` lists this conversation's subscriptions (or another's, with "watcher"), and `transfer_subscriptions` ("from": a conversation id) moves another conversation's subscriptions to this one after the user approves. `usage` shows what each provider plan of a relay has left and whether a Claude usage limit has paused turns there: check it before you start work that costs. `stop` stops a session's running turn and `archive` archives a session. The `remote_relay` tool's own description is the full reference for every action and field.

Write actions may first wait for the user's approval. If a result lists `pendingQuestions`, the other agent is waiting for an answer: ask the user (unless they told you to decide), then pass it on with `answer_question`. Always tell the user which relay and session you worked on.
