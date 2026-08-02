# Agent Rules for Prompt-Based Tests

For any automated test under `tests/` that sends a real prompt to the relay:

1. Always set `model: "gpt-5.4-mini"` in every `/api/message` request.
2. Never exceed 6 queued prompt messages per minute (global test-run limit).
3. Never include personal information or machine fingerprints in prompts/assertions.
4. Keep prompt-based helper files under ignored paths in `tests/` (do not force-add).

Use `tests/agents/helpers/relay-client.mjs` wherever possible because it enforces:
- `gpt-5.4-mini` model pinning
- rate limiting (6 / 60s)
- prompt sanitization

Detailed implementation guidance lives in `tests/agents/AGENTS.md`.
