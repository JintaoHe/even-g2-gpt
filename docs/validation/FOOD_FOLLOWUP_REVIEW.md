# Restaurant follow-up investigation — 2026-09-25

Status: **candidate only; not ready for release**. Branch `codex/food-followup-preferences`, based on merged PR 66 (`1a2adee`). No production edits, schema changes, client changes, deployment or PR in this investigation.

## Changes

- Bounded structured rejected names (6) and acceptable cuisine types (3, OR), persisted across the current meal task; new unrelated task clears preferences. Explicit removal is supported. Invalid restrictions fail closed.
- Query each cuisine separately (at most 3); apply Google `includedType` + `strictTypeFiltering` for single-cuisine queries, then local filtering, de-duplication, ranking and the existing 5-route-candidate cap. A cuisine label does not establish availability of a specific dish.
- Unsupported hard constraints ask for clarification before Maps/GPS work, not a fabricated empty recommendation. No relaxation of allergy/guarantee requirements.
- First verify up to 2 existing Google branch identities; only then use bounded web discovery. Alternative verification remains 2 rounds × 2 candidates, 60 seconds, measured route + 10-minute arrival margin, fresh Google hours and cited official food-service schedule.
- Legacy HTTP official website listings are **lookup hints only**: try the same URL over HTTPS. No HTTP requests, TLS bypass, credentials, private hosts or custom ports are permitted by this helper. The website hint alone never becomes evidence.
- Distinguish unsupported constraints, unavailable service, timeout, no returned candidates and unverified candidates. Log outcome/counts/reason labels only, never queries, GPS or provider bodies. Verified options show rating/review count and use existing rating/route ranking.

## Real evaluation (synthetic data only)

Harness: `tests/live-food-followup.ts`; opt-in `RUN_FOOD_FOLLOWUP=1`; local credentials read in memory, temporary cost/search ledgers, no conversation database. Production-style hybrid model + LocationDialogue + real Google Places/Routes and OpenAI web evidence. This is a model/runtime API evaluation, **not** an end-to-end WebSocket/G2 test. No email/calendar tools assembled.

Ten intent probes cover Chinese brand rejection, mixed English/Chinese cuisines, removing restrictions, switching to pharmacy, ordinary food knowledge, contradictory vegan/beef requirements, allergy guarantees, future visits, comparison of existing places, and cancellation. Final run: **10/10 passed**. Contradictory requests may be routed to nearby with an unsupported-constraint flag; an offline test proves this path asks before invoking Maps rather than spending or recommending.

Continuous synthetic conversation: prior IHOP suggestion → reject IHOP and request chicken/sushi/Chinese → narrow to sushi → switch to sky explanation.

| Iteration | Observation |
| --- | --- |
| Initial connection run | 13 API attempts failed locally before Google; not a product pass. Adding Node `--use-system-ca` restored requests without disabling TLS. |
| Named preference fix | Intent correct and new Maps queries ran, but both restaurant answers still had no verified options. Earlier harness checks only required querying; these were strengthened to require actual verified recommendations for these known daytime test scenarios. |
| Reuse Google candidates | Mixed-cuisine turn produced a verified Chinese option; sushi failed because Google website hints were HTTP and were discarded. |
| HTTPS hints | All 3 conversation turns passed. Mixed turn returned 2 verified options (~19.8 s); sushi returned 1 (~20.5 s); sky reply ~3.9 s, zero Maps calls. |
| Final candidate, strict cuisine search | Mixed turn returned 1 verified Chinese option (~18.7 s). Sushi did not pass (~25.0 s): report had 3 service-evidence misses and 1 provider-stage failure. The cumulative test cap also blocked further work; final sky turn was budget-blocked, **not a production crash**. This run is not fully green. |

Across runs the conservative combined OpenAI/Google reservation ceiling reached **$2.9970914 / $3**; real calls stopped. Google dollar amounts in the temporary ledger are not authoritative (unit counts are available); do not report the OpenAI subtotal as total actual API cost. `TEST_PRIOR_RESERVED_USD` carries prior reservations into a later harness process. The harness now labels budget-blocked/skipped cases explicitly; that reporting-only change has not been run against paid APIs again.

## Offline gates

- Backend: 814 tests, 812 pass, 2 skip, 0 fail.
- Even: 106/106. Both typechecks and builds pass. Initial sandboxed Vite resolution failed; identical build with required filesystem access passed.
- Final focused restaurant suite: 72/72; public working-tree scan: 395 files PASS; diff-check PASS.
- No claim of real-device acceptance or stable sushi success.

## Extended $10 evaluation (2026-09-25)

User raised the cumulative ceiling to $10, including previous reservations. Three sequential runs carried the cumulative counter forward: same-site probe, cuisine switching in West Des Moines, then different cuisines and branches at a synthetic Chicago Loop location. No production data, deployment, email or calendar writes.

- Same official site, four repetitions: 2 accepted, 2 rejected. One rejection was a definite implementation omission: an `open_page` action carries its actual URL in `action.url`, without necessarily supplying `action.sources`. The other rejection was the model reporting unknown/conflicting service evidence. These are different failures.
- Fixed the source collector to recognize actual `open_page.url`. It still rejects a URL only asserted in generated JSON, an unrelated opened URL, and a `search` action with an unsupported `url` field. Added regression coverage. OpenAI Docs was used to check the web-search action/source contract.
- Six-turn switching: Sushi → steak → Sushi → contradictory vegan/real-beef requirement → withdraw contradiction and request Chinese → sky explanation. Behavioral checks passed 5/6. Sushi, steak and Chinese produced options; returning to Sushi produced no verified option. All three cuisine changes were parsed correctly, and the IHOP exclusion survived. Contradiction and ordinary question used zero Maps calls.
- Four-turn varied-location test: Chicago pizza → Thai → severe-allergy guarantee → cancel and cat joke. Behavioral checks passed 2/4. Pizza and Thai returned no verified option despite Maps finding candidates. Allergy guarantee was not invented; cancellation stopped Maps calls.
- Total conversational checks: **7/10**, not acceptance. Restaurant turns alone: **3/6 returned options**. Latencies: switching 4.4–26.0 seconds; Chicago restaurant turns 38.0 and 23.4 seconds. No process crash or repeated city-question loop was observed. This remains a runtime/API evaluation, not a WebSocket or physical-device test.
- Important evidence-quality finding: inspection of Sakura's official page found generic opening hours, whereas the model sometimes labeled them `kitchen`, and other times returned unknown/conflict. Passing response-shape checks is **not proof that kitchen evidence is correct**. Existing generated recommendations therefore cannot be described as fully verified acceptance results. Do not loosen the gate or retry until a favorable answer merely to turn tests green.
- Other misses include exact-name/address mismatches and official URL provenance differences. Preserve exact-branch isolation; do not broadly accept model-asserted URLs or fuzzy chain matches.
- This extension made 40 OpenAI requests and 45 Google requests. Its temporary OpenAI ledgers total $0.33734242; this excludes Google costs. Cumulative **conservative request reservations: $5.2901454 / $10**, not an invoice total. All runs finished; no budget exhaustion in this extension. Remaining budget was not spent on repeated known failures.

After the source collector fix: backend **815 / 813 pass / 2 skip / 0 fail**; targeted food-followup and verified-food-alternatives **21/21**; server typecheck/build, 395-file public audit and diff-check pass. Client code was unchanged; the prior 106/106 client evidence above is not a fresh rerun.

Reproduction uses `RUN_FOOD_FOLLOWUP=1`, `TEST_MAX_USD=10`, and `TEST_PRIOR_RESERVED_USD` set to the preceding run's final counter. Modes: `--same-site --inspect`, `--full-only --switching --inspect`, `--full-only --varied --inspect`. Inspection logs contain synthetic public branch data only, never credentials. Keep them local.

## Still required before PR/release

Separate published restaurant opening hours from explicit kitchen/takeout service evidence, retain provenance, and prevent the model from upgrading the former to the latter. The $10 extension confirms instability independently of the old $3 cap; raising cost limits alone does not resolve it. Decide the qualification and wording for ordinary restaurant-hour evidence before changing that strict contract. Also address safe equivalent-name/source handling without weakening branch identity. Re-run the failed cuisine-switching and different-region cases after changes. No PR or production deployment from this candidate yet.

## Evidence classification follow-up (supersedes the pending classification item above)

After user approval to continue, the contract now distinguishes `restaurant_hours` from explicit kitchen/takeout/drive-through schedules. This is a **qualified candidate**, not confirmation of food service. Google must still report the exact branch open, primary type must be restaurant/restaurant subtype/steak house/meal takeaway (a bar or shop with a secondary restaurant type is insufficient), and both official hours and Google hours must cover measured arrival plus ten minutes. Known closed food-service windows still exclude it. Allergy, dietary guarantees and unsupported hard constraints are not relaxed.

The extraction schema now requests the verbatim schedule heading. Generic `Hours`/`Business Hours` cannot pass as kitchen evidence; explicit kinds require a matching service heading. The model's extracted heading is not independently fetched/verified HTML and is not a guarantee against factual extraction errors. The reply explicitly says kitchen cutoff is not separately confirmed for opening-hours-only candidates; the overall heading no longer claims all candidates have verified food service. Logs use `qualified` when any result has opening-hours-only evidence.

Identity fixes are bounded: business names allow `&` versus `and` while retaining exact street/city/state comparisons; official hosts allow only adding/removing one leading `www.` while source URLs must still be present in actual tool provenance. Unrelated or other subdomains remain rejected.

### Paid regression results

- Six-turn switching sequence **6/6 behavior checks passed**: sushi, steak, back to sushi, contradiction, remove contradiction and Chinese, ordinary question. Restaurant candidates: Sakura, Outback and Heavenly Asian. Restaurant turns took 18.0–42.6 seconds; non-restaurant turns 3.4–5.7 seconds. These answers were explicitly qualified restaurant-hour candidates, not proven kitchen schedules.
- Different-region sequence **4/4 behavior checks passed**: Chicago pizza (Pizza Dada, 18.2 s), then Thai (Thai Spoon and Sushi, 34.4 s), allergy guarantee refused, cancellation/joke. Non-restaurant turns had zero Maps calls. None repeated the city-question loop or crashed.
- Same official Sakura page repeated four times: **4/4 classified as `restaurant_hours`**, never kitchen, 3.6–6.8 seconds. This small sample shows the original oscillation did not recur here; it does not prove universal stability.
- The six-turn run preceded the final `www` alias and diagnostic-label adjustment; the Chicago and repeat runs used the final product code. Final offline regression covers those adjustments.
- This follow-up used 41 OpenAI requests and 45 Google requests. OpenAI-only ledger subtotal $0.35378223; Google invoice amount is not established by these temporary ledgers. Cumulative conservative request reservations across all iterations **$7.5291164 / $10**. No cap breach or budget-blocked cases, no production changes, no mail/calendar writes.

### Final gates and release scope

Backend **817 tests / 815 pass / 2 skip / 0 fail**; Even **106/106**; server typecheck/build, public audit (395 files) and diff-check pass. No schema change. Server artifact is local only. This is runtime/API testing with synthetic locations, not a G2 or production acceptance test. Known limitation: verified lookup is still slow (up to 42.6 seconds observed); missing evidence may still yield no candidate. No unconditional supply guarantee is made. Independent review and PR/release workflow remain; nothing deployed by this test run.

References: [OpenAI web search sources/domain filters](https://developers.openai.com/api/docs/guides/tools-web-search), [Google strict type filtering](https://developers.google.com/maps/documentation/places/web-service/text-search), [supported Places types](https://developers.google.com/maps/documentation/places/web-service/place-types).
