# Evidence-backed alternatives

## Behavior

When Maps returns no match, all candidates are excluded, arrival is after closing, or current suitability is unknown, continue through the existing bounded read-only web workflow instead of stopping at an empty-result message. Carry public branch addresses and exact exclusion reasons, never GPS or raw provider failures. Preserve user constraints: price/type exclusions are not silently relaxed.

Alcohol-related place requests require further local/activity verification even when the shop is open. Restaurant door hours alone do not establish kitchen service. Missing current hours, closing time or required kitchen evidence enters research. Follow-up opening checks that rule out all candidates also enter research. If jurisdiction or takeaway/on-premise intent is genuinely missing, ask one short question; timezone is not location evidence.

The shared answer policy also covers topic research, decision support and general reasoning plans: develop up to three approaches, verify decisive assumptions using relevant sources, explain why supported choices work, then leave selection/discussion to the user. Do not invent evidence or force web use for stable deductions. Known unsafe outdoor assessments and missing environment evidence activate the same research path; hazards remain authoritative, not overwritten by a convenient search result.

## Delivery guard and limits

Place/environment fallback requests require web search when available. Buffer answer deltas until response completion; require at least one completed search and citations whose URLs occur in returned tool sources before delivering a researched answer or its citations. No receipt, missing citations or mismatched sources yields a bounded uncertainty message, not a claim of verification. A closed set of location/activity questions is allowed without citations because it asserts no business facts. Cancellation/incomplete streams do not release buffered claims.

This guard proves source provenance, NOT semantic entailment or actual stock/opening. Exact-branch relevance, legal interpretation and whether every constraint is supported remain model judgments governed by instructions. Live adversarial evaluation is still required; never advertise guaranteed feasibility. Search disabled, opt-out or exhausted quotas do not invoke a fallback model and do not produce claims of research.

No new tools, write permissions, loops or automatic action execution. Existing per-request/session/daily/monthly search caps, metered fetch and provider request timeout remain in force. One alternative reply is additional to any prior Details/hour verification: the previous 30-second hours-check limit is not a whole-turn limit. Failed alternative replies are not called again by location/environment wrappers. Existing model-provider fallback behavior remains unchanged.

## Scope and validation

No schema, env, Hub UI or production deployment change. The unconnected ConditionalTaskDialogue write orchestrator is not enabled or rewired; its Calendar preview/confirmation and uncertain-write handling remain unchanged. General replies use the shared policy but do not gain automatic tools when none were authorized/selected.

Offline tests use synthetic data and fake tools only: no match, mixed exclusions, parking mismatch, unknown kitchen, alcohol/open-store distinction, no duplicate failure calls, no GPS in appended evidence, receipt/citation gating, opt-out/quota behavior, cancellation and unsafe outdoor alternatives. Real Google/OpenAI/G2 tests remain pending.

Local gates: targeted 62/62; full backend 787 total, 785 passed, 2 skipped, 0 failed; Even 106/106; both TypeScript checks, server build, 387-file public audit and diff-check passed. No production database or real API used. Changes remain local pending review/release.

OpenAI Docs checked: https://developers.openai.com/api/docs/guides/tools-web-search (required search and returned source receipts).

## Location handoff repair (PR follow-up)

Real OpenAI + Google Maps reproduced a regression: Places and Routes succeeded, but fallback research asked for a city because precise GPS was deliberately omitted and public branch addresses were not designated as a usable search scope.

Fallback now receives a typed, turn-local `searchArea`: a user-supplied area takes precedence, otherwise public candidate/excluded-branch addresses are explicit search anchors. They are **not** evidence of user residence, current jurisdiction, or actual proximity (Places bias is soft). Research must name the area and verify each venue's jurisdiction, opening and service separately; no invented route/arrival claims. The closed-set city question is unavailable once scope is supplied. No precise GPS enters model input, snapshots or logs.

If no address anchor exists, the existing Google key can make one metered reverse-geocoding request (5-second timeout, no retry). Only city/county, region and country components are returned; street addresses, coordinates and raw provider errors are discarded. This optional path requires Geocoding API permission. Denial/empty results/cost refusal fails safely to a single explicit location clarification **without a reply-model call**. The pending task retains the original destination and travel mode, so a bare city reply continues that task. Session reset/cancellation clears pending state. No key permissions are changed by this PR.

Live validation with a public synthetic West Des Moines location:

- Original Chinese hunger request and a different hot-food follow-up: real Places/Routes/Details and real model/search completed; both returned sourced alternatives instead of asking for city (about 17.1 s and 10.9 s).
- Forced empty Maps result + real geocoding returned `REQUEST_DENIED` with the current key. The one location clarification was expected, **not** a successful geocoding test. A bare `West Des Moines, Iowa` then resumed the original restaurant request and produced a sourced alternative (~15.0 s), without repeating the city question.
- Successful reverse-geocoding, missing components, provider failures, cancellation, cost reservation and GPS stripping are covered offline. Live geocoding success remains unverified until API access is explicitly enabled by the administrator.
- These two live runs used temporary ledgers, synthetic conversations, no business DB, mail or Calendar. OpenAI settled approximately $0.064; Google units were recorded (2 Text Search, 1 Matrix element, 1 Details; denied geocoding settled to zero). Temporary-ledger Google free-tier accounting is **not** proof of the account's actual Google bill. Each harness run independently caps conservative reservation at $1.

References: Google reverse geocoding https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-reverse-geocoding ; pricing https://developers.google.com/maps/billing-and-pricing/pricing . No schema, env, client or model-profile changes.

### Release status: location fix validated; recommendation quality NOT accepted

Do not treat the harness's no-city-question assertions as factual recommendation acceptance. Subsequent live runs found an overnight-day error (Friday 22:00 opening presented as feasible on Friday at 01:00). The prompt now explicitly explains previous-day overnight intervals and provides the weekday; this is mitigation, **not a deterministic hours validator**.

Further live validation with the configured search-call cap still produced an exact Domino's closing-time claim not established by the cited branch page. Other runs fell back to the fixed uncertainty message. Therefore the overall verified-alternatives behavior has **not** passed live quality acceptance. A source-URL receipt alone cannot establish that the cited page entails an opening-hours claim. Before rollout acceptance, the researched alternatives need structured, per-branch current-hours/service evidence validation rather than only citation membership. Keep this repair PR draft/unmerged pending that work and retest; do not deploy on the strength of the location-only assertions.

Latest local validation: backend 793 total / 791 passed / 2 skipped / 0 failed (two runs), focused location/routes/answer-options 55/55, Even 106/106, both typechecks and builds passed. The final weekday prompt addition was included in the focused run; CI must check the final full tree. Public scan: 390 files. This round's live calls used synthetic data and temporary ledgers; OpenAI settled approximately $0.20 total across diagnostic and validation runs. No production writes or key-permission changes.
