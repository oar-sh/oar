# GitHub Copilot CLI BYOK guide

This document summarizes how to use GitHub Copilot CLI with your own model provider ("BYOK" / bring your own key), with a focus on managing multiple API keys cleanly.

## What BYOK means

Copilot CLI can use either:

1. GitHub-hosted models, authenticated with GitHub.
2. Your own model provider, configured with environment variables.

In BYOK mode, Copilot CLI sends prompts and context directly to the provider you configure. GitHub authentication is not required for the model request itself.

## Supported providers

The official Copilot CLI docs currently describe support for:

- OpenAI-compatible endpoints
- Azure OpenAI
- Anthropic
- Local model servers such as Ollama or vLLM when they expose an OpenAI-compatible API

## Provider requirements

Your model must support:

- Tool calling
- Streaming responses

For best results, GitHub recommends a context window of at least 128k tokens.

## Environment variables

Copilot CLI uses these variables to select and configure the active provider:

| Variable | Purpose |
|---|---|
| `COPILOT_PROVIDER_TYPE` | Provider type: `openai` (default), `azure`, or `anthropic` |
| `COPILOT_PROVIDER_BASE_URL` | Base URL for the provider API |
| `COPILOT_PROVIDER_API_KEY` | API key for the provider |
| `COPILOT_MODEL` | Model name to use |

Notes:

- `COPILOT_PROVIDER_API_KEY` is optional for providers that do not require auth, such as local Ollama instances.
- `COPILOT_MODEL` is required when using a custom provider.

## Basic setup examples

### OpenAI

```powershell
$env:COPILOT_PROVIDER_TYPE = "openai"
$env:COPILOT_PROVIDER_BASE_URL = "https://api.openai.com/v1"
$env:COPILOT_PROVIDER_API_KEY = $env:OPENAI_API_KEY
$env:COPILOT_MODEL = "gpt-4.1"
copilot
```

### Anthropic

```powershell
$env:COPILOT_PROVIDER_TYPE = "anthropic"
$env:COPILOT_PROVIDER_BASE_URL = "https://api.anthropic.com/v1"
$env:COPILOT_PROVIDER_API_KEY = $env:ANTHROPIC_API_KEY
$env:COPILOT_MODEL = "claude-sonnet-4-5"
copilot
```

## Using multiple API keys

Copilot CLI does not mix providers inside a single running session. The practical pattern is:

- keep multiple API keys available in your shell environment
- set one provider at a time for each Copilot CLI process
- use separate terminal windows, tabs, or shell sessions if you want to work with more than one provider at once

### Recommended pattern

Store the provider keys separately:

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

Then launch one Copilot session per provider:

```powershell
# Session 1: OpenAI
$env:COPILOT_PROVIDER_TYPE = "openai"
$env:COPILOT_PROVIDER_BASE_URL = "https://api.openai.com/v1"
$env:COPILOT_PROVIDER_API_KEY = $env:OPENAI_API_KEY
$env:COPILOT_MODEL = "gpt-4.1"
copilot
```

```powershell
# Session 2: Anthropic
$env:COPILOT_PROVIDER_TYPE = "anthropic"
$env:COPILOT_PROVIDER_BASE_URL = "https://api.anthropic.com/v1"
$env:COPILOT_PROVIDER_API_KEY = $env:ANTHROPIC_API_KEY
$env:COPILOT_MODEL = "claude-sonnet-4-5"
copilot
```

### Safer switching with helper functions

If you switch providers often, wrap the configuration in shell functions so each launch is explicit:

```powershell
function Use-CopilotOpenAI {
    $env:COPILOT_PROVIDER_TYPE = "openai"
    $env:COPILOT_PROVIDER_BASE_URL = "https://api.openai.com/v1"
    $env:COPILOT_PROVIDER_API_KEY = $env:OPENAI_API_KEY
    $env:COPILOT_MODEL = "gpt-4.1"
}

function Use-CopilotAnthropic {
    $env:COPILOT_PROVIDER_TYPE = "anthropic"
    $env:COPILOT_PROVIDER_BASE_URL = "https://api.anthropic.com/v1"
    $env:COPILOT_PROVIDER_API_KEY = $env:ANTHROPIC_API_KEY
    $env:COPILOT_MODEL = "claude-sonnet-4-5"
}
```

Usage:

```powershell
Use-CopilotOpenAI
copilot

Use-CopilotAnthropic
copilot
```

## Multiple keys in one shell

You can keep multiple keys in the same shell, but only the currently assigned `COPILOT_PROVIDER_*` values are used by the next Copilot CLI process.

That means:

- one active provider config per process
- no provider auto-fallback
- no built-in key rotation across providers inside one session

If a provider configuration is invalid, Copilot CLI exits with an error rather than silently falling back to another provider.

## Authentication notes

- BYOK does not require GitHub authentication for the model call.
- GitHub-hosted mode still uses normal Copilot authentication.
- If you are using a local model server, you may not need an API key at all.

## Configuration help

Run this in a terminal for provider-specific help:

```powershell
copilot help providers
```

## Practical workflow

1. Pick the provider you want for the current session.
2. Export or assign the provider environment variables.
3. Set `COPILOT_MODEL` for that provider.
4. Start `copilot`.
5. Open a second terminal if you want a second provider active at the same time.

## In OAR

The relay does not take these variables from its own environment. BYOK in OAR is the OpenAI provider: save the key, model and base URL in **⚙️ Settings → Providers → OpenAI** (see [OpenAI (BYOK)](providers.md#openai-byok-and-openai-image)).

- For an OpenAI conversation the relay sets `COPILOT_PROVIDER_TYPE=openai`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY` and `COPILOT_MODEL` on that conversation's worker, plus `COPILOT_PROVIDER_WIRE_API` (`responses` for `gpt-5*`, `codex-*`, `o1`, `o3` and `o4-*` models, `completions` for the rest).
- It removes these variables from every other worker, so a `COPILOT_PROVIDER_*` set in the relay's environment never turns GitHub-hosted Copilot conversations into BYOK ones. Only the `openai` type is used; `azure` and `anthropic` are not available through OAR.
- `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` and `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS` in the relay's environment do apply: on Copilot's SDK engine they replace, for OpenAI conversations, the token limits OAR knows for the model (see [Environment variables](configuration.md#environment-variables)).

## Source references

- GitHub Docs: "About GitHub Copilot CLI" -> "Using your own model provider"
- GitHub Docs: "Using GitHub Copilot CLI"
- GitHub Docs: CLI command reference and authentication docs
