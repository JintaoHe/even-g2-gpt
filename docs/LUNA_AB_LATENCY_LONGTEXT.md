# Luna A/B round 2: latency and long text

Date: 2026-09-22 (America/Chicago). Models: `gpt-5.6-luna`, `gpt-6-luna`.
No Jev, production model changes, deployment, email, Calendar write, or business
database access. Same existing cumulative $3 authorization as round 1.

## Predeclared workload

Run `tests/live-luna-ab.ts` with `RUN_LIVE_LUNA_AB=1` and
`LUNA_AB_PROFILE=latency-longtext`. `tests/luna-focus-cases.ts` defines this round.
`tests/luna-focus-report.ts <local-jsonl-path>` produces read-only descriptive
statistics. Artifacts and raw evidence stay under the ignored `.local/evals/`.

- Intent: six scenarios, four repeats, both models; short input and 40-message
  synthetic long history. Existing production medium/1024-token intent settings.
- Streaming replies: short-input/low and long-input/medium, four repeats each.
  Measure first nonempty output delta and full reply time; retain output lengths.
- Documents: three scenarios, two repeats each, both models: original tool-sharing
  control, new oral-history archive migration, new cold-chain offline backfill
  with 40 synthetic source messages. Each asks for six chapters, 6,000–8,000 Han
  characters, a code block per chapter, and four exact proper nouns/identifiers.
- Same production segmented document generator, unchanged prompts, `none`
  reasoning, two section workers and bounded repairs. No model-specific tuning.
  Model order reverses every repeat. Generated UTC clock text is fixed for both.

## What the measurements mean

These are Windows-client-to-API wall-clock timings, not isolated provider inference
latency or Linux/glasses performance. First-delta timing starts at reply invocation
and does not include earlier intent classification or STT. The document pipeline
is non-streaming: headers latency must not be presented as a first-token metric.
Full document time includes planning, sections and required repairs. Stage totals
can exceed wall-clock time because section workers overlap.

Small repeated samples do not establish a production p95 SLO or a failure rate.
Keep medians, maxima, pairwise deltas, cache and reasoning-token counts visible.
The offline regression suite ran alongside the initial part of the live run;
check later repeats separately before attributing small latency differences to
models. Cache state and external provider load are uncontrolled.

## Quality checks

Count H2 headings outside code blocks; detect repeated exact headings and open
fences; count prose Han characters; check exact protected names and partial flags.
Screen prose for editorial/process-language patterns. Keep and manually inspect
flagged artifacts; a passing regex screen is not proof of good prose or correct
engineering. No hidden repair, discarded failure, or selective successful retry.

## Budget and safety

The same nonrefundable authorization ledger from round 1 starts at $1.0510154.
Per-request reservations use the higher of ordinary input and cache-write price
as the conservative input bound. Monthly usage is accounted separately. Keys and
raw provider error bodies are never logged. Local backend must be stopped to
avoid competing writers to its ledger. No additional Google requests this round.

## Latency results

Raw run: `.local/evals/luna-ab-2026-09-23T02-01-49-826Z.jsonl`.
Both models pass all 24 intent cases. Per-scenario medians (four samples each):

| Intent scenario | 5.6 seconds | 6 seconds |
| --- | ---: | ---: |
| Casual | 1.82 | 2.05 |
| Calendar read | 2.54 | 2.26 |
| Document request | 2.54 | 2.40 |
| Long-history follow-up | 2.86 | 3.50 |
| Long-history document request | 2.82 | 3.79 |
| Negated exit | 1.81 | 3.67 |

6 is slower on every paired long-history intent case and every negated-exit case,
including repeats after the regression suite ended. The effect is not uniformly
present: short read routing is faster on 6 in three of four pairs. Both see exactly
211,656 input tokens across the intent set, with 190,656 cached tokens. Returned
reasoning-token totals differ: 886 for 5.6, 3,508 for 6 at the same medium setting.
This is an observed association, not a controlled causal explanation of latency.

| Streaming reply scenario | 5.6 first delta | 6 first delta | 5.6 full reply | 6 full reply |
| --- | ---: | ---: | ---: | ---: |
| Short input, low | 1.20s | 0.62s | 3.47s | 2.11s |
| Long input, medium | 2.02s | 1.93s | 3.82s | 3.11s |

Four samples per cell. Short-output lengths are comparable (median 191.5 vs 192.5
code points). For long input, 6 has one slow outlier: 4.32s first delta / 4.96s full
reply, versus 5.6 maxima 2.44s / 4.32s. 6 wins full-reply latency in 7/8 paired
samples but does not win every first-delta comparison. These reply pass counts
check nonempty completion only; they are not new semantic-accuracy scores.

## Long-document results

All 12 requested attempts completed. 5.6 passes **5/6**; 6 passes **2/6**.
These are this workload's acceptance counts, not estimated population failure rates.

| Scenario / repeat | 5.6 seconds / Han chars / result | 6 seconds / Han chars / result |
| --- | --- | --- |
| Tools control / 0 | 60.68 / 6,434 / pass | 51.81 / 6,362 / pass |
| Archive / 0 | 61.46 / 6,127 / pass | 41.71 / 6,720 / pass |
| Long-source outage / 0 | 60.71 / 6,145 / pass | 45.85 / 5,202 / editorial text + too short |
| Tools control / 1 | 73.98 / 6,396 / pass | 7.42 / no artifact / HTTP 400 |
| Archive / 1 | 54.78 / 5,969 / too short | 45.79 / 6,226 / partial artifact |
| Long-source outage / 1 | 56.83 / 6,120 / pass | 45.96 / 6,946 / editorial text |

Median time to a returned artifact (including failed-quality/partial artifacts) is
**60.69s for 5.6, 45.85s for 6**. The 7.42s no-artifact failure is excluded from
this latency metric, but remains a failed attempt and is included in costs. Every
pair with two artifacts was faster on 6. This does not establish faster delivery
of an acceptable document: only two 6 artifacts passed, insufficient to estimate
a stable success-conditioned latency distribution.

### Failure evidence and classification

- 5.6 archive repeat 1 has 5,969 prose Han characters, below the requested 6,000.
  The strict threshold was not relaxed. No editorial-pattern hits in its six
  artifacts; all preserve six headings, closed fences and protected names.
- 6 long-source repeat 0 includes prose beginning `[CONSTRAINTS: NO_SEND...]
  Must append...` and `We need append only...`; it also misses the length floor.
  Repeat 1 includes `We need append 394-727 chars...` in the finished prose.
  Both are actual user-visible process text, not code-fence examples or merely
  grader false positives. The first-round contamination therefore reproduces on
  a new topic and both repeats with long source data.
- 6 tools repeat 1: one section request returns HTTP 400, safe error code
  `invalid_prompt`; the sibling worker is then aborted. The harness's coarse
  `TIMEOUT` label conflates AbortError with timeout: this companion cancellation
  must not be interpreted as a separate demonstrated network timeout. The outer
  case reports generic `EVALUATION_FAILED`; request metadata supplies the 400.
- 6 archive repeat 1: an extension request returns HTTP 400 `invalid_prompt`;
  the production fallback preserves a partial chapter (`incompleteSections:[3]`).
  The total length passes but `partial:true` fails the finished-document gate.
- The two 400s are API-level failures, distinct from prose-quality failures.
  Their finer cause is not established; no raw provider error message is exposed.
  They were not retried selectively to replace the failed samples.

### Pipeline work

5.6: 6 plans, 36 initial sections, **35 extensions** (77 document requests).
6: 6 plans, 32 initial-section attempts, 23 extensions, 2 rewrites and 1 continuation
(64 document requests, including rejected/cancelled calls). Fewer 6 calls partly
reflect the aborted document, not only greater efficiency.
Both pipelines spend substantial time extending short initial sections. That is
a separate prompt/pipeline optimization opportunity; prompts remained unchanged
for this comparison. Altering them now would no longer test drop-in replacement.

## Cost, gates and recommendation

207 OpenAI request attempts in this round. Usage-based cost estimate is
**$0.22811709**; one aborted request has unknown usage and retains a conservative
$0.00197525 reservation, giving **$0.23009234** including that uncertainty.
No new Google charges. Across both rounds, the stricter nonrefundable authorization
ledger is **$2.586371225 / $3**; this is reservation consumption, not actual billing.
The run exited normally, all observers finished and the exclusive lock was removed.

Document usage totals, including failed outputs: 5.6 **$0.140204**, 6 **$0.059491**.
Dividing all attempted-document cost by accepted artifacts gives about **$0.0280**
per accepted 5.6 artifact versus **$0.0297** for 6 (about $0.0307 if the unknown
cancelled request is included). This is a descriptive ratio on six trials each,
not a production unit-cost forecast. Cheap tokens did not buy cheaper accepted
documents in this particular batch.

**Recommendation:** retain 5.6 for production intent and long documents. 6 is a
credible candidate for ordinary streaming replies, where its latency advantage
is clearer. Do not apply one model to every role based on aggregate speed or
price. Before any document migration, address and re-evaluate both editorial
contamination and API rejections; before changing reply defaults, independently
review semantic and safety cases. No production defaults or environment changed.

Offline validation: 655 tests, 653 passed, 2 skipped, 0 failed. New deterministic
checks verify code-fence-aware grading, repeated headings and editorial markers.
TypeScript, server build, public audit (354 files), and diff-check passed.
This report complements, rather than overwrites, round 1's
`LUNA_AB_EVALUATION.md`.
