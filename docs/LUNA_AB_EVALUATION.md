# Luna model A/B evaluation

Date: 2026-09-22 (America/Chicago). Baseline: `e8d9853`.
Candidate branch: `codex/luna-model-ab`. Production model/configuration unchanged.

Follow-up: [round 2 latency and long-text evaluation](LUNA_AB_LATENCY_LONGTEXT.md)
adds 12 document attempts and separates first-delta latency from complete delivery.

## Scope and safeguards

The owner authorized a cumulative $3 evaluation of `gpt-5.6-luna` versus
`gpt-6-luna`, including Google and other API compatibility. The opt-in harness is
`tests/live-luna-ab.ts` (`RUN_LIVE_LUNA_AB=1`). It requires the local backend to
be stopped before sharing the monthly cost ledger.

- Responses API, Standard service tier, identical task prompts and per-task
  reasoning/output budgets; repeated tasks alternate model order. The generated
  clock sentence is frozen. No model-specific prompt optimization.
- Nonrefundable worst-case reservations in a separate, fixed-period authorization
  ledger survive reruns. Limits: OpenAI $2.80, Google $0.19, other $0.01, total $3.
  Actual usage separately settles into the normal monthly ledger. Do not delete
  the authorization ledger to rerun under this authorization.
- Synthetic conversations, public Madison bookstore data and public Node.js
  release metadata only. No business conversation database, migrations, email
  sends, Calendar writes, deployment, or production model switch.
- Calendar connectivity only refreshes OAuth and reads the bound calendar's
  metadata. No events or account identifiers are logged or sent to a model.
  Model Calendar tool results are explicitly synthetic tentative events.
- Google Places/Routes run through the application's provider adapter. The same
  returned public evidence is then supplied to both models. The model does not
  directly authenticate to Google: compatibility means function selection,
  arguments, tool-result round trip and interpretation, not key compatibility.
- Raw errors and credentials are not printed. Local JSONL contains synthetic
  answers, public evidence, latency and usage metadata. TLS verification remains
  enabled (`--use-system-ca` on this Windows environment).

## Official API and price baseline

[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) supports
reasoning levels and function calling on Responses. The `none` constraint for
Chat Completions with function calling must not be applied to our Responses
integration. Both models are tested with low, medium and high tool calls.

Standard USD per million tokens (short context):

| Model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Luna | 0.20 | 0.02 | 0.25 | 1.20 |
| GPT-6 Luna | 0.10 | 0.01 | 0.125 | 0.50 |

Sources: [5.6 model](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[6 model](https://developers.openai.com/api/docs/models/gpt-6-luna),
[pricing](https://developers.openai.com/api/docs/pricing).
These are published rates, not a guarantee that prices cannot change. Evaluation
costs use response usage and these rates; they are estimates, not invoice totals.

## Measurement limitations and corrections

- Small repeated application scenarios are not a general intelligence benchmark
  or a soak test. Regex/schema checks cannot prove semantic correctness.
- Tool round trips name the expected read tool; spontaneous routing is tested
  separately through the production intent planner. No real destructive tools
  are exposed. No real STT/audio or hardware latency test is included.
- The initial venue-follow-up grader mistakenly expected `place_analysis`.
  The application's existing enum is `analyze_places`. Original JSONL is kept;
  report corrected scores separately using that exact existing enum. This is a
  test-fixture correction, not a prompt/model change or an API retry.
- Two 5.6 answers saying “我不记得…也不会猜测” failed an overly narrow
  missing-evidence regex. Manual review accepts both as correct refusals to
  invent an address; the future grader includes `不记得`. Preserve raw scores
  and disclose this correction instead of claiming that 6 beat 5.6 on this case.
- The initial Calendar connectivity probe failed with a generic error. A separate
  run of `scripts/google-calendar-check.ts` succeeded (refresh accepted, bound
  calendar readable, no events read/modified). Root cause of the first failure
  is unconfirmed; do not erase it or attribute it to either model. The harness
  now preserves safe Calendar error codes for future diagnosis.

Manual reading adds qualifications beyond the automated checks:

- Both models distinguish a proposed launch from a decision, and historical
  confirmation from a successful email send. Neither invents a home address.
- On the short high-effort idempotency question, 6 gives a clearer distinction
  between two different operations sharing a timestamp and a retried operation;
  one 5.6 counterexample confusingly calls a genuine duplicate a false positive.
  This is a small observed difference, not a general reasoning ranking.
- The public evidence contains three shops but the user asks for “two.” 6 asks
  which two on both repeats; 5.6 compares the first two once and asks once. Both
  are defensible, but this case does not prove autonomous venue recommendation.
- Both summary models are conservative about unexecuted actions. Both also
  soften “改为周六” into a still-discussed date in some fields. Distinguishing a
  conversational decision from authorization to execute remains a semantic
  evaluation limitation; strict JSON/schema success alone is insufficient.

## Results

Completed run: `luna-ab-2026-09-23T01-33-38-444Z.jsonl` under `.local/evals/`.
221 OpenAI requests (111 for 5.6, 110 for 6), all HTTP/completion successful.
This includes internal document calls; successful API completion does not mean
the resulting document passed quality checks.

| Phase | 5.6 checks passed | 6 checks passed | 5.6 median seconds | 6 median seconds |
| --- | ---: | ---: | ---: | ---: |
| Function-tool round trip (3 tools × 3 efforts) | 9/9 | 9/9 | 3.04 | 3.14 |
| Intent (16 scenarios × 3) | 48/48 | 48/48 | 1.85 | 2.63 |
| Short replies (8 scenarios × 2) | 16/16 | 16/16 | 1.41 | 1.34 |
| Summaries | 2/2 | 2/2 | 3.44 | 1.91 |
| Six-chapter long documents | 2/2 | **1/2** | 48.67 | 43.18 |

Scores incorporate the disclosed grader corrections. Original raw intent scores
were 45/48 for both, and raw short-reply score was 14/16 for 5.6. Automated reply
and summary scores remain narrow checks, not comprehensive human quality ratings.
Nearest-rank intent p95: 3.28s (5.6), 4.65s (6); other samples are too small for
meaningful tail-latency conclusions. Network/provider variability is not isolated.

### Long-document counterexample

Both 5.6 outputs have six H2 sections, 6,614 and 6,105 prose Han characters, all
four protected names, and no partial flag. 6 produces 6,775 and 6,618 characters;
its second output has **seven H2 headings**, repeating `数据模型` at lines 35/37.
Manual review also finds English editorial instructions in the final artifact:
at line 152, an “append only” instruction; at line 188, a paragraph beginning
“We need append only” discussing how to satisfy length constraints. This is
user-visible drafting-process text, not an acceptable finished engineering note.
The artifact is `luna-ab-2026-09-23T01-33-38-444Z-gpt-6-luna-1.md`.

The same production document prompts/configuration were used for both models,
including `reasoning.effort=none`. This setting is the document pipeline's current
choice, **not** a universal GPT-6 requirement. One failure in two documents is a
counterexample to drop-in equivalence, not an estimate of a production failure rate.
No prompt changes or masking of the failed output were made to manufacture a pass.

### External services

- Google Places plus Routes: real public query passed, three candidates returned.
- Calendar: first connectivity attempt failed, separate read-only retry passed.
  Model calendar compatibility uses synthetic results, not private events.
- GitHub public release API: real read passed; returned release metadata used in
  both models' tool round trips.
- Real SMTP sending, Calendar modifications, STT, hardware audio, and built-in
  web-search execution are not covered. Intent selection for web search is covered.

### Cost

| Phase | 5.6 estimated USD | 6 estimated USD |
| --- | ---: | ---: |
| Preflight | 0.000008 | 0.000004 |
| Tool round trips | 0.002766 | 0.001108 |
| Intent | 0.014620 | 0.008468 |
| Short replies | 0.004130 | 0.001864 |
| Summaries | 0.000840 | 0.000235 |
| Documents, including failed-quality artifact | 0.024552 | 0.011710 |
| **Total** | **0.046917** | **0.023388** |

6 costs about 50% less for this workload, **including its failed-quality document**.
Repeated intent prompts receive heavy cache hits (251,148 of 256,986 input tokens
for each model); this is not a cold-cache production bill forecast.
Combined OpenAI usage estimate is $0.070305. Google sticker-price reservation is
$0.065 (free SKU allowances may reduce actual Google charges), giving a conservative
usage-plus-Google bound of $0.135305. The stricter cumulative authorization ledger
consumed **$1.0510154 of $3** in nonrefundable worst-case reservations. Reservation
consumption is not actual billing. Run finished normally and released its lock.

## Recommendation

Do not replace all production model roles with 6 yet. API/tool compatibility is
good and cost is lower, but intent median latency is about 0.78s slower here, and
the long-document counterexample fails the current consumer-facing quality gate.
Keep 5.6 for production intent and documents. 6 is a reasonable candidate for a
separate, controlled short-reply/summary trial, with the semantic limitations above
included in its acceptance cases. Do not deploy or change defaults based on this
report alone. The current patch only enables fair opt-in adaptive configuration
and per-model metering; no model default, .env value, key, or Linux service changed.

Offline gates: 653 tests, 651 passed, 2 skipped, 0 failed; TypeScript, server
build, public audit (349 files before this report), and diff whitespace check
passed. New tests verify identical adaptive configuration and per-model cost
settlement. Production defaults remain `gpt-5.6-luna`.
