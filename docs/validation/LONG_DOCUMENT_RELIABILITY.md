# Long-document release validation

## Scope and implementation

The original local checkpoint covers the bounded document generation changes in
[Email delivery](../EMAIL_DELIVERY.md). A later owner-reported production check is
recorded separately below; it is not physical-device or soak acceptance.
The model, email recipient, credentials, Calendar permissions and deployment settings
are unchanged. No email was sent and no Calendar event was written in these tests.

- Carry the requested total prose range into the outline and validate allocations.
- Give sections explicit prose and byte budgets; reserve 25% of initial token allowance for one closing continuation.
- Repair at most once per section. Append to complete short prose without rewriting
  existing content; rewrite truncated/oversized content with original requirements.
- Validate the total prose range after assembly instead of treating every chapter's
  allocation as an independent user requirement.
- Preserve explicit partial metadata and warnings on failure. Calendar-bearing
  artifacts fail closed; sending still requires a separate preview-bound confirmation.
- At most two section workers; at most six sections, one continuation and one repair
  per section. No unbounded retry loop or new search/tool calls.

## Real API results

Synthetic community-library engineering plan: exactly six chapters, requested
6,000–8,000 Han characters outside code. Protected names: Cedar Lantern, LIB-7042,
Mira Chen, Orion Shelf 7. The same local model/configuration was used across runs.

| Consecutive final-strategy run | Han characters (including headings) | Elapsed | Partial | Continuations |
| --- | ---: | ---: | --- | ---: |
| 1 | 6,345 | 42.3 s | No | 0 |
| 2 | 6,335 | 45.3 s | No | 0 |
| 3 | 6,862 | 45.5 s | No | 0 |

All six chapters completed and all four protected names were retained in every
run. Each run used one outline call, six body calls and six bounded repair calls.
Generation also checks the body-only total against the requested range. These are
three samples, not a universal success-rate or latency guarantee. Earlier failed
strategies are not counted as passing: whole-section expansion undershot, and an
initial append strategy discarded useful repairs on per-section length mismatch.

The first passing artifact was read in full: six ordered chapters, complete prose
and closed code examples; suggestions remain proposals rather than claims of work
performed. Engineering examples still require normal human technical review and
must not be treated as executable, production-certified code.

## Offline and security evidence

- Full suite: 425 tests, 423 passed, two Windows symlink-related skips, zero failures.
- Typecheck and server-only build passed.
- Working-tree public-source audit includes new untracked test files; no detected
  credential or prohibited-path findings. Automated scanning is not a guarantee.
- Regression coverage includes double truncation, failed repair, partial warnings,
  fresh send approval, cancellation, Calendar fail-closed, preserved append content,
  cross-section space allocation and completed-but-underlength partial drafts.

## Reproduce and remaining gates

Run the opt-in command documented in [Email delivery](../EMAIL_DELIVERY.md).
Synthetic artifacts and token/timing reports stay in ignored `.local/evals/`;
timestamped files preserve separate runs. No production data is used.

- [x] Local automated build/tests and targeted real API gate.
- [ ] Owner's local simulator acceptance: request a long document, inspect the saved
  artifact and confirmation preview; also inspect an explicitly partial fixture.
- [x] Review/merge the source changes, then deploy the server-only build (#51, `390e430`).
- [x] Post-deploy Linux smoke test and security/drift checks (16 operational files match).

## Owner-reported production regression — 2026-09-21

The owner tested release `390e430` via public WSS with a protocol-v2 client,
location capability disabled, using the same synthetic library project. This
record is based on the supplied report, not an independent reread of production data.

- Answer/preview completed in 52.8 seconds; document metric: 49,885 ms.
- Six chapters, 23,551 bytes, 6,296 Han characters outside code (6,309 overall).
- Six closed code blocks; all four protected names retained; complete ending.
- Completed job, no reported partial/warning metadata or DRAFT errors.
- Owner cancelled sending; no email or Calendar write occurred.

The production long-document regression gate is closed on this evidence: three
local passes plus one production pass. These four samples do not prove general
reliability, physical-device behavior, or long-running stability. Production test
artifacts remain ordinary retained user data; do not commit them here.

## Separate open issue: delivery intent routing

A legacy-protocol attempt containing “生成后先给我预览，不要直接发送邮件”
reportedly produced no document job. Both wording and protocol changed in the
successful attempt, so cancellation-rule precedence remains a hypothesis.
The current prompt already excludes workload comparisons such as 2GB/4GB from
document generation. Do not declare that false-positive fixed from prompt text alone.

`tests/live-delivery-intent.ts` fixes the classifier call path and tests eight
paired cases: generation without sending, export control, comparison without/with
an artifact request, English negation, pending cancellation, revision and negated
generation. The abbreviated failed request and comparison are reconstructed
fixtures, not claimed to be verbatim captures. No prompt behavior change is made.

Opt-in paid evaluation (not CI):

```bash
RUN_LIVE_DELIVERY_INTENT=1 node --import tsx tests/live-delivery-intent.ts
```

Only synthetic inputs go to the intent model. This does not generate documents,
connect to production, send mail, or write Calendar events. It reports every case
and exits nonzero on mismatches or request failures. Classifier results alone do
not close the legacy/v2 end-to-end routing issue.

Local classifier baseline on 2026-09-21: unchanged `gpt-5.6-luna` intent prompt,
8/8 passed in one run (1.2–2.4 seconds per case), including both reported failure
directions. No generation, email or Calendar writes. Typecheck and public-source
audit passed. This single isolated pass does not invalidate the owner's production
failure: exact history, capability configuration, protocol handling and stochastic
variation remain to be compared before changing the prompt.
