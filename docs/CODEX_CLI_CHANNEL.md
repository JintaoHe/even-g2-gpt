# Deployment choice: API or Codex CLI

The Conversation Lab supports `DIALOGUE_PROVIDER=api` (default) or `DIALOGUE_PROVIDER=codex-cli`. This is server-side deployment configuration, not a browser-supplied command. Existing `.env` and the running API server are not automatically switched. Restart the conversation server after changing configuration.

| Capability | API | Codex CLI first version |
| --- | --- | --- |
| Intent and answer | OpenAI Responses | Two `codex exec` processes per answered turn |
| low / medium / high | Adaptive | Intent classification uses medium; answers have a low floor |
| Context | Application history | Application history supplied on stdin each turn |
| Delivery | Token streaming | Final complete message; no simulated typing |
| Interrupt/exit | Abort request / confirmation | Terminate owned CLI process tree / same confirmation |
| Web search | Existing bounded search quota | Native live search with Codex account usage; no API fallback |
| Waiting feedback | Understanding/thinking/streaming | Understanding/thinking, real search events, elapsed time |
| Voice transcription | OpenAI API key | Still OpenAI API key; otherwise text-only UI |
| Authentication/billing | API key | Separately logged-in ChatGPT/Codex account and its limits |

CLI is not unlimited or guaranteed free. Usage depends on the authenticated account and available allowance. This adapter does not pass OPENAI_API_KEY or CODEX_API_KEY to the CLI and forces ChatGPT authentication to avoid silently billing the STT key for dialogue. It never copies login credentials, bypasses limits, or falls back to paid API requests when CLI fails. Each self-hosting user should use their own account; this is not a shared public multi-user credential service.

## Setup

1. Install Codex CLI on the deployment machine. The installed version must support `exec --json --ephemeral --ignore-user-config --ignore-rules --output-schema`, the configured model, and the feature configuration in `src/codex-dialogue.ts`. Live Windows validation used standalone `0.154.0`; older versions may fail closed and need upgrading. No automatic install or login is performed.
2. As the same OS user that will run the server, run `codex login` (or `codex login --device-auth` on headless Linux), then `codex login status`. Complete login yourself. Protect the account auth store like a password. A dedicated unprivileged service account/container is recommended on Linux.
3. Set in `.env`:

```dotenv
DIALOGUE_PROVIDER=codex-cli
CODEX_MODEL=gpt-5.6-luna
CODEX_TIMEOUT_MS=120000
CODEX_WEB_SEARCH=true
# Optional absolute native binary path; Windows must use codex.exe, not .cmd/.ps1.
# CODEX_CLI_PATH=/usr/local/bin/codex
```

Keep G2_CLIENT_TOKEN (32+ characters) for client authentication. Keep OPENAI_API_KEY if microphone transcription is desired; without it CLI mode accepts typed messages only. Merely signing into Codex Desktop does not prove the separately launched CLI is logged in.

4. Restart `src/conversation-server.ts`, refresh and reconnect. The page shows the selected channel and limitations. The server remains localhost-only; Linux public hosting still requires a separate TLS/auth/reverse-proxy deployment review.
5. Roll back by setting `DIALOGUE_PROVIDER=api` with OPENAI_API_KEY and restarting. No calendar/list/file actions are enabled in either channel.

## Safety and limitations

Prompts go to stdin, never a shell command. Each run uses an empty temporary working directory, read-only sandbox, no approvals, ignored user config/rules, disabled project documents, local execution tools, plugins and hooks. Only native hosted web search is permitted in answer requests. Classification always disables search. A replacement instruction file limits the coding agent to dialogue and read-only research. Only a small environment allowlist is forwarded. No transcript or raw CLI diagnostics are logged by the adapter. Application conversation storage remains unchanged. Ephemeral mode disables session rollout persistence, not all possible CLI authentication/diagnostic metadata.

`CODEX_WEB_SEARCH=false` disables CLI search independently of `OPENAI_WEB_SEARCH`. CLI does not reserve or modify `.local/search-usage.json`: the API 10/answer, 50/session, 100/day and 1200/calendar-month limits remain API-only. The CLI is subject to account allowance; timeout, cancellation and output-size protections remain active. There is no claimed exact per-task search-count cap in this CLI adapter, and the OpenAI API project `$40` hard limit does not cap a separately authenticated ChatGPT/Codex subscription.

Only actual `item.started` / `item.updated` / `item.completed` web_search events trigger researching/organizing feedback. Merely enabling search does not show researching. Search queries, internal reasoning and raw tool output are not sent to the UI. The timer shows elapsed waiting time, not percentage completion. Completion, interruption, pause, exit, failure and disconnect clear feedback. CLI sources are requested as titles and full URLs in the answer text; API-style structured citation rendering is not yet implemented for CLI.

Read-only sandbox alone is not a privacy boundary; host administrators and the CLI runtime still have access to their service account's files. Production should use a dedicated least-privilege account, keep unrelated secrets out of its filesystem, and test the exact CLI version. Unexpected tool events fail the adapter; this check is defense in depth, not a substitute for tool disabling and OS isolation.

Timeouts, invalid events, unsupported models, missing login and quota errors stop the turn; there is no hidden retry or provider switch. CLI process startup overhead and full-message delivery may be noticeably slower than API. No CLI latency claim has been validated yet.

## Validation

`tests/codex-dialogue.test.ts` uses a local fake subprocess (not a model) to verify JSONL framing, UTF-8, error sanitization, provider selection, environment filtering, context/effort handoff, cancellation and timeouts.

Live validation on 2026-09-16: standalone Windows CLI `0.154.0`, using the existing ChatGPT login, completed intent classification and an answer with four native web-search calls (eight start/completion status events). No API key was forwarded. This verifies the transport, not the factual accuracy or latency of arbitrary answers. The restricted development sandbox could not access the login; the normal user execution context could. No credential files were read or copied.

Set `CODEX_CLI_PATH` to the native executable returned by `Get-Command codex` on Windows instead of relying on PATH when multiple installations exist. The smoke test respects CODEX_CLI_PATH and CODEX_MODEL. Real tests consume account allowance.

The installed CLI emitted a fatal Code Mode configuration warning when both code_mode and code_mode_host were disabled. The adapter now disables code_mode without overriding its host setting; command tools remain disabled. Search-enabled replies use at least low reasoning because live none tests returned answers without any search events, whereas low invoked search. Classification uses medium; replies use adaptive low/medium/high. This is an empirical compatibility default, not a claim that none can never search.

Official references: [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [authentication and headless login](https://learn.chatgpt.com/docs/auth), [CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
