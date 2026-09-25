# Nearby recommendation verification

Candidate branch based on main #64. No schema or environment changes. Client logic is unchanged; the Hub package version is bumped to 0.2.10 for this release.

## Contract

- Identity before directions: exclude parking/transit primary types unless explicitly requested. A sole incidental parking result cannot stand in for a requested shop. Other mixed purposes still use the bounded semantic clarifier.
- Narrow whole-utterance recommendation follow-ups use the existing place-analysis path. Additional destinations/categories or route requests remain planner-driven. This is not a universal natural-language classifier.
- Current Places search requests hours for named destinations as well as nearby searches. Known closed nearby candidates are removed as before; remaining recommendations are checked against arrival time.
- Per turn: at most 4 exact Place-ID Details reads, at most 2 one-search official-web verifications, 30 seconds for the verification stage. Details have a 10-second timeout and no retry. Stop early at two confirmed choices. Search/discovery and route computation precede this stage and retain their existing timeouts; 30 seconds is not a total-turn latency promise.
- Reuse evidence younger than 2 minutes; clock rollback invalidates it. Recomparison retains original timestamps rather than laundering old evidence as fresh. Explicit opening-hours follow-ups refresh old evidence without requesting GPS/Routes again; prior journey times remain historical estimates.
- Clearly closed is excluded, unknown stays unknown. Confirmed-open choices precede unknown choices; when all are unknown the UI does not recommend departing. Current opening is not a guarantee against unforeseen closures.
- Compare absolute RFC3339 closing timestamps against now + journey duration, including midnight. No server-timezone weekday arithmetic. Kitchen secondary hours are separate from door-opening hours. Missing kitchen/closing evidence is disclosed, not inferred.
- Website lookup only after exact-ID details: send the provider's public business name/address/website and current UTC, never user GPS, conversation, credentials or private history. One required web_search call, restricted to the provider website host. Require matching branch, a returned source URL present in actual search sources, matching official host, and a valid closing timestamp for an open assertion. Missing website, ambiguous branch, holiday uncertainty, unsupported timezone, quota refusal, timeout or tool failure remain unknown.
- Existing metered OpenAI fetch and search daily/monthly/session quotas remain in force. Google Details Enterprise gets its own SKU (1,000 monthly free units; $20/1,000 first paid tier); monthly total limits are NOT raised. Failed/uncertain calls keep existing conservative reservations.
- Only public read tools added. Guest route reads retain access checks before and after; cancellation rejects late delivery. No booking, mail, calendar writes or fallback to user-history search.

## Offline coverage / remaining acceptance

Final local gates: backend 776 total / 774 passed / 2 skipped / 0 failed; Even 106/106; both TypeScript checks, server/client builds, 384-file working-tree public audit and diff-check passed. Client build initially hit sandbox directory permissions; rerunning with the required filesystem permission succeeded, without weakening checks.

Tests use fake fetch/models and temporary ledgers only: sole parking candidate, explicit parking, repeated recommendation vs new query, exact branch and source receipts, quota denial, freshness/rollback, kitchen closure, midnight/arrival boundary, early stop, 4/2 limits, 30-second default and injected short deadline, non-cooperative late responses, cancellation, unknown display and real dialogue integration.

Real Google/OpenAI and G2 acceptance are pending; no live APIs or production database were used for implementation. Search evidence is model-interpreted, not an absolute guarantee of actual opening.

## Official references checked

- Google Place Details: https://developers.google.com/maps/documentation/places/web-service/place-details
- Google current/secondary opening-hours timestamps: https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places
- Google SKU pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- OpenAI web search (required tool, bounded calls, domain filter and sources): https://developers.openai.com/api/docs/guides/tools-web-search
