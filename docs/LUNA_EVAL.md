# Luna versus 4.1 mini

Commands: `npm run luna:eval` and `npm run baseline:eval` (paid; stop server first, shared single-process quota ledger).
Reports: `.local/evals/luna-conversation-latest.json` and `.local/evals/baseline-conversation-latest.json` include timestamps and per-case answers/timing.
Same prompts, adapter and state machine. Sequential runs: Luna then mini; no concurrent API jobs. Each suite makes 39 requests including a probe; each run used one hosted search. Zero searches for greetings/no-browse questions. Reservations settled correctly in both runs.
Luna uses `reasoning.effort=none`; mini omits reasoning. Both use 128 intent tokens and 1400 reply tokens. STT and hardware not included.

| Check | Luna | Mini |
|---|---|---|
| Intent (12 cases repeated twice) | 22/24 | 21/24 |
| Four-turn context/correction/translation | 4/4 | 4/4 |
| Explicit exit and confirmation | Pass | Pass |
| Programmatic streaming interruption | Pass | Pass |
| Search routing, citations, quota settlement | 3/3 | 3/3 |
| Total mechanical checks | 31/33 | 30/33 |

Both returned wait twice on forced submission of unfinished speech. Existing Conversation logic overrides waiting on forced submission, so this does not stall the application. We retain these raw classifier failures instead of relabeling them. Mini additionally returned wait once on a completed joined sentence. Neither falsely exited in this small set.

First text times, including intent + reply but excluding STT:

| Turn | Luna | Mini |
|---|---:|---:|
| Remember project | 1.779s | 1.179s |
| Correct fields | 4.163s | 1.566s |
| Recall corrected fields | 1.662s | 1.606s |
| Translate retaining Even | 1.915s | 2.573s |
| Median | 1.847s | 1.586s |
| Mean | 2.380s | 1.731s |

Search-only first text: Luna 2.788s, mini 1.885s; completion 3.079s vs 2.519s. Luna was somewhat slower, with a 4.163s outlier. Small sequential samples, not p95 or a guarantee of equivalent speed.

Manual financial review: Luna's fiscal quarter, quarter end, release date, revenue and growth percentages matched the independently opened NVIDIA source: Q2 FY2027, ended July 26 2026, published August 26, $96.2 billion = 962 亿美元, 106% YoY and 18% QoQ.
Source: https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-second-quarter-fiscal-2027
Mini stated July 27 instead of July 26 and included unrequested stock data. Citation/routing passes alone are NOT factual-quality passes. One checked example does not establish general financial reliability.

Decision: promote Luna none-reasoning to BOTH roles as a provisional personal-use default under the user's conditional authorization. It meets this small baseline for quality; speed is usable but not identical. Actual aggregate cost was not measured; no total savings claim. Search 20/day and 600/calendar-month limits unchanged. No real write tools added; STT unchanged.
Rollback: set `OPENAI_INTENT_MODEL=gpt-4.1-mini` and `OPENAI_REPLY_MODEL=gpt-4.1-mini` in `.env`, then restart. Explicit legacy OPENAI_DIALOGUE_MODEL remains a fallback override. Secrets untouched.
Official reference: https://developers.openai.com/api/docs/models/gpt-5.6-luna
