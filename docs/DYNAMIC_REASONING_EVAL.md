# Dynamic reasoning evaluation

> Historical baseline: this evaluation predates the `high` answer tier and the current medium-effort intent classifier with low/medium/high answers. Keep it for comparison; do not treat it as validation of the current three-tier answer router.

Run: 2026-09-16 UTC. Model: gpt-5.6-luna for intent and answer. Existing application code and prompts unchanged.

## Method

`tests/live-dynamic-reasoning.ts` runs two six-turn conversations twice (24 turns, 48 paid API calls). Each conversation keeps actual preceding assistant answers in history. Expectations are specified before execution. Web search is disabled; no production search quota, microphone, browser, or G2 hardware is involved.

The test checks actual outgoing request bodies as well as answer.start events: exactly one none-effort classifier call and one streaming answer call per turn, matching selected effort, no tools, successful completion. It stores only synthetic prompts/answers and non-secret request metadata in `.local/evals/dynamic-reasoning-latest.json`.

## Results

24/24 turns matched the expected effort and transport assertions. Both repetitions produced identical effort sequences:

| Scenario | Sequence |
| --- | --- |
| Simple fact → explanation → multi-constraint transport policy → arithmetic → ordinary comparison → thanks | none → low → medium → none → low → none |
| Translation → contextual definition → difficult moral-responsibility argument → quoted deep-thinking phrase → explicit deep follow-up → negated deep-thinking/simple fact | none → low → medium → none → medium → none |

The complex third questions do not explicitly request a reasoning mode or say “think deeply”. The router raises effort based on the task, then lowers it for simple questions without resetting the conversation. Quoted and negated deep-thinking requests did not trigger medium in these cases.

| Selected effort | Turns | Median first-text latency | Observed range |
| --- | ---: | ---: | ---: |
| none | 12 | 1.445 s | 1.299–1.842 s |
| low | 6 | 1.537 s | 1.236–2.840 s |
| medium | 6 | 2.547 s | 1.268–2.657 s |

Latency includes classification and first answer text, but not STT or display transport. Different questions were used at different efforts: these numbers do not isolate the causal cost of changing effort on the same question. Full complex policy responses took about 7.1–8.5 seconds to finish streaming.

## Limits / follow-up

- Small, deliberately selected sample; 24/24 is not a general accuracy estimate. Adjacent low/medium boundaries are subjective.
- This verifies automatic per-turn selection, not changes midway through a single answer or stronger answer quality than fixed effort.
- Some complex answers were several hundred Chinese characters despite the concise-answer preference. That is a separate HUD summarization/pagination issue; higher reasoning should not automatically require a longer displayed answer. No production behavior changed during this evaluation.
- Actual microphone/transcription and G2 display performance remain untested here.
