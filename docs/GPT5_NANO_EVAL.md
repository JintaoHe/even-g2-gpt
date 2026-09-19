# GPT-5 nano tool-calling smoke test

Live run: see timestamp and raw results in `.local/evals/nano-tools-latest.json`.
Command: `npm run nano:eval` (paid API requests, explicit opt-in; not part of `npm test`).
Stop the conversation server before running: the search quota file supports only one process.
Run from the project root. No automatic retries. Default application model and `.env` unchanged.

## Configuration and scope

- Exact model: `gpt-5-nano`, Responses API, Standard service tier, `reasoning.effort=low`, streaming, 2048 output-token budget.
- Strict function schemas with automatic tool choice and parallel tool calls disabled.
- Memory/list/deployment tools are fixtures: **no real actions executed**. One simulated permission-denied result is returned to test the full tool round-trip.
- Date interpretation is controlled: prompt explicitly defines Tuesday 2026-09-15 and next Friday as 2026-09-18. This is not a test of ambiguous relative-date resolution.
- One genuine hosted `web_search` call, forced with `tool_choice=required`, capped at one and charged to the then-current 20/day, 600/calendar-month ledger. This historical test predates the current 10/answer, 50/session, 100/day, 1200/month defaults and tests compatibility, not autonomous search routing.
- Nine paid requests total. Reported usage: 11,488 input tokens, 2,253 output tokens (including 1,600 reasoning tokens). No STT calls.

## Observations

| Check | Result |
|---|---|
| Greeting does not call tools | Passed |
| Bilingual memory preference selects update_memory and preserves meaning | Passed |
| Oat milk goes to shopping list, not work list | Passed |
| Deployment date and preserve_notes=true | Passed |
| Negated instruction does not call tools | Passed |
| Quoted instruction does not call tools | Passed for routing; translation failed, see below |
| Missing list/item asks for clarification without a tool call | Passed |
| Simulated permission denial is acknowledged, not reported as success | Passed |
| Hosted web_search executes and returns URL citations | Passed |

**Language defect:** In the quoted-command translation, the model translated the assistant name `Even` as “甚至”.
The automatic routing check still passes because it checks only that no tool executes; it is NOT a general quality score.
Greeting also addressed “Hi Even” back to the user. A production prompt should establish assistant identity and protected names, followed by separate retesting.
The financial answer contained an awkward fiscal-period introduction. Citation presence was checked, not the accuracy of each financial claim.

Single-run timing: three function-call responses completed in 1.77–3.12 seconds.
Hosted search: first tool event 0.80 seconds, first answer text 3.59 seconds, complete 3.88 seconds.
These exclude microphone capture, STT, and the app's separate intent classifier. They are not a latency benchmark or a controlled comparison against 4.1 mini.

## Conclusion

In this account and run, GPT-5 nano supports both custom function calling and hosted web_search with low reasoning.
The small smoke test supports further evaluation, not a claim that it is universally more accurate/faster/cheaper in total.
Before switching the application: test semantic exit/wait decisions with an adequate reasoning-token budget, follow-up context, entity preservation, automatic search/no-search routing, and repeated end-to-end latency.
The existing production classifier's 128-token budget cannot simply be assumed sufficient for a reasoning model.

References: [model](https://developers.openai.com/api/docs/models/gpt-5-nano), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [web search](https://developers.openai.com/api/docs/guides/tools-web-search).

## Second run: application conversation adapter

Command: `npm run nano:conversation:eval` (paid; stop the lab first).
Raw results: `.local/evals/nano-conversation-latest.json`, including timestamp, input, answer, timing and individual checks.
The real `OpenAIDialogue` and `Conversation` classes were used, not a replacement classifier.
Opt-in adapter options: low reasoning, 2048 intent tokens, 3072 reply tokens, explicit assistant identity/proper-name preservation.
These options are supplied by the evaluation only; the default server model, token limits and `.env` are unchanged.

Result: **30/33 automated checks passed**, from 38 real model requests. This is a smoke-test score, not a general accuracy estimate.

- Intent: 21/24 checks passed (12 cases, each repeated twice).
- “如果我说退下吧，你会怎么办？” incorrectly returned `exit` in one of two runs. The existing UI confirmation prevents immediate final closure, but capture would stop and the conversation would be interrupted. This is a material blocker to using this profile as the default exit classifier.
- Forced submit of an unfinished sentence returned `wait` in both runs despite the explicit instruction. `Conversation` already overrides waiting on forced submit, so this classifier noncompliance is not an app-level deadlock.
- Four-turn context/correction/translation: 4/4 checks passed. Cedar was retained; Ian/date were corrected to Mei/2026-09-21; the final recall did not retain old values. Explicit identity guidance plus explicit user guidance preserved Even in the translation. This does not establish that the system prompt alone fixed every entity-preservation issue.
- Semantic exit plus confirm: passed; entered exit_pending, rejected further input, then closed after confirmation.
- Interruption: passed; the test interrupted on the first text delta, cancelled the reply and emitted no late text or answer.done. This is programmatic interruption, not a new physical microphone test, and does not verify server-side billing cancellation.
- Auto-search: 3/3 routing checks passed with `tool_choice=auto`: greeting and explicit no-browse explanation did not search; an explicit current NVIDIA report query did search and return a citation. At most one search per reply, charged to the existing ledger; one actual search in this run.

Conversation first-text latencies (including intent + answer calls, excluding STT): 5.90s, 5.07s, 2.48s, 6.70s.
Search-only answer: first text 3.00s, completion 3.36s. Single sequential run, no controlled 4.1-mini baseline.
No aggregate cost comparison was measured in this second run.

Quality caveat: automatic search checks validate routing and citation presence, not financial correctness. The no-browse answer also blurred total market capitalization with free-float capitalization; passing routing does not mean all factual wording is correct.

Recommendation: do not switch the entire assistant to nano yet. A separate nano reply model while retaining the existing intent classifier is a possible next experiment, or improve and retest the nano classifier on an expanded held-out set. Neither has been made the default.
Offline regression suite after the optional adapter extension: **26/26 passed**, TypeScript typecheck passed.

## Third run: mixed intent/reply profile

Implemented `HybridDialogue` and shared factory used by both server and evaluation. Intent: `gpt-4.1-mini`, 128 output tokens, no tools. Reply: `gpt-5-nano`, low reasoning, 3072 output tokens, name-preservation instructions. STT unchanged.
Run with `npm run hybrid:eval`; raw report `.local/evals/hybrid-conversation-latest.json`.

**Result: 28/33 checks passed. NOT promoted to the default.**

- Intent: 21/24. Both hypothetical-exit trials correctly returned respond. One joined unfinished/completed sentence incorrectly returned wait; both forced submissions still returned wait (existing application override applies).
- Four-turn conversation: 3/4. On final recall nano said the project code was not supplied, although Cedar was present in earlier turns. It retained Mei and the corrected date. Translation preserved Even.
- Real exit/confirmation and programmatic streaming interruption passed.
- Greeting and no-browse search routing passed. Current-news search executed and produced citations, but quota settlement emitted quota_unavailable, so the search check FAILED. The existing adapter hides settlement errors; this report cannot establish whether the cause was an unexpected returned tool count or a storage failure. The reservation remains charged. Do not infer from this run that the nano search cap is fully validated.
- The financial response also selected an older fiscal period despite asking for the latest report, and its revenue-unit conversion requires independent verification. Citation presence is not factual validation.
- Four conversation first-text times (including intent, excluding STT): 2.38s, 2.18s, 2.99s, 2.68s. These runs were not randomized/repeated enough to establish comparative speed or cost.

Safe handoff: model roles can now be selected independently, but default stays 4.1 mini for BOTH roles. To explicitly experiment later set `OPENAI_REPLY_MODEL=gpt-5-nano` and restart. To revert set it to `gpt-4.1-mini`. No `.env` secrets were edited.
Next gates before promotion: held-out context retention and completion cases, transparent search settlement diagnostics, independent factual/units review, then repeated cost and latency measurements.
