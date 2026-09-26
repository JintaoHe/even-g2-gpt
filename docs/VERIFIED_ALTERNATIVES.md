# Evidence-backed alternatives

## Behavior

### Ordinary restaurant search (supersedes the strict food pipeline below)

Ordinary restaurant requests now use Maps candidates (name, cuisine, rating/review count, address and opening fields) followed by one bounded web-search reply for basic menu, AYCE and hours information. They no longer require separate per-branch kitchen schedules or an arrival-margin proof before offering candidates. Missing facts remain unknown, not closed; explicitly closed branches must not be recommended as open. AYCE needs menu/site evidence, and a 24-hour branch listing is not a guarantee about dine-in or each menu item. Exact closing/ETA claims still need evidence.

AYCE terms remain in the Maps query. Explicitly abandoning a cuisine for a named brand starts a replacement task and clears obsolete cuisine/AYCE constraints. Actual contradictions, allergy guarantees and alcohol/local-law requests retain their separate safeguards. No schema, client, budget, model routing or production configuration change. Tool receipts and citations remain required for researched claims; this does not prove semantic accuracy. Real-device acceptance is still required.

Synthetic live smoke (`tests/live-food-followup.ts --simple`): AYCE sushi then switching to McDonald's both invoked Maps and produced sourced answers without the old constraint refusal or a repeated city question (15.6 s / 15.0 s). The second plan was `replace` with cuisine restrictions cleared. This verifies control flow, not every live business fact. OpenAI settled $0.02914762; cumulative conservative reservations including previous runs reached $7.9390896 of the existing $10 cap. Google temporary-ledger free-tier figures are not the actual account bill. No business DB or write APIs were used. A subsequent prompt-only refinement discourages generic 'confirm before departure' advice; that exact wording change has not had another paid smoke run.

Local regression: focused 61/61; backend 819 total / 817 passed / 2 skipped / 0 failed; Even 106/106; both TypeScript checks, server build, 395-file public audit and diff-check passed. Not deployed.

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

### Earlier candidate: location fix validated; recommendation quality NOT accepted

Do not treat the harness's no-city-question assertions as factual recommendation acceptance. Subsequent live runs found an overnight-day error (Friday 22:00 opening presented as feasible on Friday at 01:00). The prompt now explicitly explains previous-day overnight intervals and provides the weekday; this is mitigation, **not a deterministic hours validator**.

Further live validation with the configured search-call cap still produced an exact Domino's closing-time claim not established by the cited branch page. Other runs fell back to the fixed uncertainty message. Therefore the overall verified-alternatives behavior has **not** passed live quality acceptance. A source-URL receipt alone cannot establish that the cited page entails an opening-hours claim. Before rollout acceptance, the researched alternatives need structured, per-branch current-hours/service evidence validation rather than only citation membership. Keep this repair PR draft/unmerged pending that work and retest; do not deploy on the strength of the location-only assertions.

Latest local validation: backend 793 total / 791 passed / 2 skipped / 0 failed (two runs), focused location/routes/answer-options 55/55, Even 106/106, both typechecks and builds passed. The final weekday prompt addition was included in the focused run; CI must check the final full tree. Public scan: 390 files. This round's live calls used synthetic data and temporary ledgers; OpenAI settled approximately $0.20 total across diagnostic and validation runs. No production writes or key-permission changes.

### Structured immediate-food fallback (supersedes the earlier food release blocker)

The API-backed immediate-food fallback no longer delivers a free-form web answer as a verified recommendation. Web research proposes up to two public branches; Google must resolve exactly one matching name/street/city/state and return fresh current opening evidence, a next closing timestamp and the branch's IANA timezone. Routes calculates travel time. A separate domain-restricted structured search extracts explicit kitchen/takeout/drive-through weekly service periods from the retrieved official branch site. Code, not the model, evaluates the start weekday (including yesterday's overnight interval), arrival plus a ten-minute margin, travel-mode compatibility and known closure conflicts. Store hours alone are not food-service evidence. DST transitions are conservatively rejected instead of guessed.

If neither first-round candidate qualifies, at most one additional search excludes those candidates. Maximum: two discovery rounds, two candidates per round, up to two web tools per structured request, 60-second overall verification deadline; all existing search quota and cost reservations apply, including partial quota grants. Cancellation discards late results. Exact GPS goes only to Google. No arbitrary server-side URL fetching is introduced. Guest reverse-geocoding forwarding retains access checks before and after the lookup.

Replies are code-formatted from validated fields and retain source citations, rather than reproducing a model-written closing-time claim. Unknown service, missing hours, ambiguous identity, unknown price under a price ceiling, unsupported exclusions or atmosphere requirements are not silently promoted to feasible. If none passes, the reply states the missing opening/service/arrival evidence without claiming no food exists or telling the user to verify an untested list. Verified branches replace the recent comparison so follow-ups do not reference the failed original list.

**Limits:** This is a bounded evidence check, not a guarantee against temporary closure, sold-out food, erroneous provider data or model extraction error. Weekly service extraction still uses an LLM and retrieved public information. Strict address matching may miss valid branches. This change covers immediate food alternatives in API-backed location dialogue; it does not establish deterministic legal verification for alcohol, future visits, arbitrary dietary requirements or all general reasoning workflows. The existing separately scoped research paths are unchanged. No schema/env/client-package change.

Latest final synthetic live pair (real OpenAI + Google, West Des Moines, Friday early morning): original hunger question returned one checked drive-through option in 25.75 s; hot-food wording returned a checked option in 17.80 s. Both used Google current status and Routes plus an official weekly drive-through schedule, and neither asked for the city. No unsupported exact closing time was delivered. OpenAI settled $0.09084115 for this pair; 13 Google calls (6 Text Search, 3 Matrix elements, 4 Details) were recorded. Conservative total reservation was $0.643, below the harness $1 cap. Earlier development runs returned uncertainty and are not counted as successful recommendation trials. Synthetic-only evidence inspection is opt-in; no business DB, emails or Calendar writes. Linux and real-device acceptance remain separate after merge/deployment.

Implementation references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [web-search source receipts](https://developers.openai.com/api/docs/guides/tools-web-search), [Google Places opening hours and IANA timezone](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places). Source receipts establish retrieval, not semantic entailment; separate provider and time checks remain necessary.

Final local gates: backend 805 total / 803 passed / 2 skipped / 0 failed; focused availability/location/structured-alternative tests 57/57; Even 106/106; both typechecks/builds, 392-file public scan and diff-check passed. CI remains required for the pushed commit. The opt-in live harness's basic assertions still test routing/privacy rather than exhaustive semantic quality; the cited structured evidence above was inspected separately.
