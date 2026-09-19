# Intent reasoning A/B evaluation

Run: 2026-09-18 UTC. Model: `gpt-5.6-luna`. Web search and every external action tool were disabled.

## Question

Compare the existing low-effort intent classifier with a medium-effort candidate before changing the default. The evaluation measures semantic routing and extraction, not final-answer quality.

## Method

`scripts/intent-reasoning-ab.ts` runs 17 synthetic cases twice at both efforts (68 paid API requests). Low uses a 256-token output ceiling; medium uses 1,024 so reasoning does not crowd out the strict structured output. Each low/medium pair runs concurrently to reduce temporal bias.

Cases cover clean and noisy bilingual Target routing, explicit origins and travel modes, ambiguous and ordinal place references, place-purpose clarification, calendar query/create/details/confirmation, Markdown creation and natural send confirmation, quoted/negated/direct exit, and incomplete speech. The test never invokes Google Maps, Calendar, email, microphone, or production quota ledgers. Detailed local results are written to ignored `.local/evals/intent-reasoning-ab-latest.json`.

## Results

| Classifier | Passed | Median | p90 |
| --- | ---: | ---: | ---: |
| low | 34/34 | 1,026 ms | 1,370 ms |
| medium | 34/34 | 1,306 ms | 2,212 ms |

Medium added 280 ms at the median and 842 ms at p90 in this run. It did not improve the already-perfect selected-case score, so the result does not prove that medium is more accurate. The project nevertheless adopts medium for intent classification because intent/tool routing is the assistant's control plane and the measured delay is acceptable for the single-user product goal. Answers use adaptive low/medium/high.

## Limits

- Two repetitions and hand-selected cases are too small for a general accuracy estimate.
- Concurrent pairs share transient network and provider conditions.
- Output-token ceilings differ intentionally to represent viable production configurations.
- Re-run the evaluation after changing intent prompts, schemas, model snapshots, or adding a new action tool.

Official OpenAI guidance recommends representative evaluations and comparing task success, latency, reasoning tokens, and cost. It generally recommends low for extraction/routing/classification and medium or high for diagnosis, comparison, and planning; our medium choice is therefore a product-specific reliability preference, not a universal recommendation.

Source: https://developers.openai.com/api/docs/guides/deployment-checklist
