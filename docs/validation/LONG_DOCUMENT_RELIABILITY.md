# Long-document local release gate

## Scope and implementation

This checkpoint covers the bounded document generation changes described in
[Email delivery](../EMAIL_DELIVERY.md), not production or physical-device acceptance.
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
- [ ] Review/merge the source changes, then deploy the server-only build.
- [ ] Post-deploy Linux smoke test and security/drift checks.

No production deployment, service restart, Hub package build or soak restart was
performed for this checkpoint.
