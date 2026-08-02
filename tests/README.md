# E2E Tests

Playwright test code and test documentation live under this folder.

## Run tests

From the repository root:

```bash
npm run test:e2e
```

The root script uses this config file:

- `tests/playwright.config.mjs`

You can also run Playwright directly:

```bash
npx playwright test --config tests/playwright.config.mjs
```

## Scope

Current suite coverage includes:

- relay question UI and answer flow
- workspace root behavior and path handling
- file preview and security checks
- usage button API integration
- drives explorer behavior
- file and folder reference token UX

## Agent prompt-test rules

For tests that send real prompts to the relay, follow `tests/AGENTS.md` and
`tests/agents/AGENTS.md`.
