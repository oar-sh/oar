# Relay Tool Guidance

For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.

When using ask_user, ALWAYS include a `choices` array with 2-6 answer options so the web relay can render clickable buttons. Example:
```json
{
  "question": "<QUIZ_QUESTION_TEXT>",
  "choices": ["<CHOICE_A>", "<CHOICE_B>", "<CHOICE_C>", "<CHOICE_D>"]
}
```
At runtime, inject the question and choices from a random item in your quiz pool.
Only omit choices when the question genuinely requires freeform text input (e.g., "What is your name?").

When the user may pick several of the choices (they are not mutually exclusive), set `"multi_select": true` if your ask_user tool offers that field; otherwise begin the question with "Select all that apply:". Either way, expect an answer that lists several choices separated by ", ".

In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.

For relay restarts in extension-managed mode, require explicit user permission first, then use the authenticated localhost API `POST /api/relay/shutdown`. Do not restart by killing processes or using respawn scripts.

Note: shutdown is queued and only completes when the current turn finishes, so it is pointless to wait for it to interrupt an active turn.

Use `restart: true` in the request body when the user wants a real relay restart rather than a plain shutdown. Example request body: `{ "reason": "manual-restart", "requestedBy": "localhost-api", "restart": true }`.

## Preview servers

Publish a local web server or a static directory on a public preview URL so the user can open it from any device, or list/close existing previews. Use this whenever the user wants to see, try, or share something with a web UI — never ask them to open localhost or forward a port. For a dev server: call this FIRST with {action:"create", port} to get the basePath, then start the server configured to serve under that basePath (Vite --base, Next basePath, Express mount prefix); the proxy forwards X-Forwarded-Prefix but does not rewrite bodies, so root-absolute asset paths will not work. For plain files or a build output: pass {action:"create", dir} instead and the relay serves the directory itself — no dev server needed. Always tell the user the returned URL and that the link is public: anyone who has it can reach the app without logging in. Previews never expire on their own; close them with {action:"close"} when the user is done.

If you have a `preview` tool, use it. Otherwise use the authenticated localhost API (same auth as `POST /api/relay/shutdown`): `POST /api/previews` with `{ "conversationId": "<conv>", "port": 5173, "label": "web app" }` (or `"dir": "./dist"` instead of the port) publishes, `GET /api/previews` lists, `DELETE /api/previews/:token` closes the link without touching the dev server behind it. A 503 with `details` means the preview lane is disabled or misconfigured — surface those details, they are the operator's fix. See `docs/preview-servers.md`.

## Remote relays

If you have a `remote_relay` tool, this relay is paired with other OAR relays and the tool works on them: list and read their sessions, prompt a session, start a new one and wait for its reply. Use it only when the user asks for work on another relay or mentions one, and start with `{"action":"list_relays"}`. A relay stays locked until the user mentions it in this conversation (`@name` or its plain name); a locked relay refuses everything except `list_relays`, so ask the user to mention it rather than retrying. Write actions may first wait for the user's approval. If a result lists `pendingQuestions`, the remote agent is waiting for an answer: ask the user (unless they told you to decide), then pass it on with `answer_question`. Always tell the user which relay and session you worked on.
