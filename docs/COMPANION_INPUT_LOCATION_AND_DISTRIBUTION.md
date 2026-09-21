# Companion input, location, and safe distribution

Status: implementation checkpoint recorded on 2026-09-18. The phone text input
already exists in the SDK client. Source now contains an automatic, session-scoped
location context refreshed at most every 10 seconds and a Google Places/Routes path; it has passed mock/local automated
tests but has not yet passed the user's local simulator acceptance, Linux deployment,
or physical-device permission/lifecycle testing. Arbitrary-recipient delivery remains
disabled.

## Product identity

The packaged display name is **Glass Assistant**. It intentionally does not use
`Even`, `Even AI`, `G2`, `Official`, or another name that could imply a first-party
application. The repository may describe the supported hardware, but every public
listing and README must state that this is an independent community project and is
not affiliated with or endorsed by Even Realities.

`Glass Assistant` is an acceptable working name for Private Testing. Before the
permanent package ID is registered, do one final Even Hub name/ID availability
check. A later branding change must not silently reuse another developer's name or
suggest official status.

## Phone text input

An Even Hub plugin is a web application running in a phone WebView; the glasses are
the display and gesture/audio surface. The current companion page already includes
a normal HTML text area. Submitted text goes through the same authenticated WSS
conversation as speech, and the response appears on the glasses.

This is the intended fallback for:

- email addresses, URLs, IDs, names, and other strings that are awkward to speak;
- private environments where speaking aloud is inappropriate;
- correcting a speech transcription without starting a new audio turn.

The glasses do not provide a keyboard. The input control lives on the phone. Voice
remains the default, and typing is optional.

Before supporting a request such as “send this to me and CC my partner,” add a
structured recipient flow rather than allowing model-generated addresses to be
executed directly:

1. the user types or selects the address on the phone;
2. the server validates and normalizes it;
3. the glasses show the recipient/CC preview with masked or shortened addresses;
4. the user confirms the exact delivery action;
5. the server sends once with an idempotency key and reports success or failure.

The LLM may propose an email action but cannot bypass the preview/policy executor.
API keys, SMTP credentials, OAuth tokens, passwords, and the backend access token
must never be entered into the free-form conversation box.

## Location and route-time design

SDK `0.0.14` exposes one-shot and continuous phone location through
`getAppLocation`, `startAppLocationUpdates`, `stopAppLocationUpdates`, and
`onAppLocationChanged`. The manifest permission name is `location`. A returned
location can include latitude, longitude, accuracy, altitude, speed, heading, and
timestamp.

No project-owned native GPS bridge is required. The runtime path documented by
Even is:

`plugin WebView -> EvenAppBridge (SDK) -> Even phone app host -> phone OS location`

Our TypeScript calls the SDK directly; `EvenAppBridge` is the platform bridge.
The glasses and Linux server do not read the phone GPS themselves. The SDK docs
also state that location APIs route through the phone and do not require the
glasses startup page. They do require the app to run inside the Even App WebView;
a normal browser has no native handler. SDK `0.0.14` requires Even App `2.2.9` or
later, and the package manifest must continue to request `location`.

The implementation is deliberately narrower than the SDK permits:

1. Luna classifies a named route, nearby-place comparison, or recent-comparison
   follow-up and returns only structured intent, query and travel mode. It does not
   receive coordinates. Driving is the default; explicit walking/cycling requests
   or the companion selector set the session preference. Transit is deferred;
2. the server sends a request ID for the first or stale location fix. The client tries at most
   three times (`high` 7 seconds, `high` 5 seconds, then `medium` 3 seconds) and
   accepts a fix only when reported accuracy is 100 metres or better;
   protocol-v2 clients declare `client_capabilities.location` in `hello`. The Even
   plugin declares `true`; the text-only browser lab declares `false`. A client
   that cannot answer a location request fails immediately into the normal
   city/timezone clarification instead of waiting for the 22-second watchdog;
3. before the first successful fix, the glasses warn that the phone may show its
   system permission prompt. The SDK does not expose whether that dialog is
   currently visible, so this is a pre-emptive hint rather than dialog detection;
4. after the first successful permission-backed fix, the client asks the SDK for
   continuous updates at a 10-second interval without a distance-only trigger. The
   WSS boundary accepts bounded continuous updates for the authenticated session
   and rejects invalid, stale, excessively skewed, inaccurate, or unexpected data.
   Late results after cancellation are ignored;
5. exact coordinates go directly from the authenticated session to the server-side
   Google Places/Routes executor. They never enter model input, conversation
   history, logs, analytics, MD exports, browser storage, or an `.ehpk`;
6. Places search returns a bounded candidate set and at most three candidates
   enter one Route Matrix call. Nearby discovery starts with a 20 km soft bias and
   widens once to 50 km when empty; a named destination uses a legal 50 km soft
   bias that explicit city/address text can override. Legal destinations are not
   deleted by type: a
   parking area, transit stop, pharmacy, store department, or main store may each
   be intentional. When candidate purposes differ, Luna sees only bounded public
   place metadata (never coordinates) and either selects a type already explicit
   in the request or asks one concise clarification. The clarified reply becomes
   a self-contained destination query and uses the newest fresh session fix. One Route
   Matrix call compares the selected candidates. Driving uses
   `TRAFFIC_AWARE`; walking/cycling do not claim automobile traffic. Rating
   confidence and very-low-rating risk can affect the recommendation, without
   scraping or presenting individual review text. When a named temporary event is
   absent from Places, one quota-accounted OpenAI web search may identify its public
   venue from recent text context. It receives no coordinates, and the result must
   be revalidated by Places before routing;
7. the newest exact fix remains only in volatile memory for the connected session.
   A fresh fix can serve follow-up routes, time-zone resolution and environment
   checks; a fix older than two minutes is never treated as current and triggers a
   new bounded request. Explicit stop/clear, permission loss, disconnect, system
   exit or conversational session end clears it. No durable background tracking is
   started after the app/session closes;
8. recent candidate Place IDs and bounded display/rating fields may remain only in
   memory for ten minutes. A follow-up mode comparison uses the newest fresh-enough
   session fix, reuses those IDs and skips a second Places search;
9. if all three attempts fail, the assistant asks the user to say or type a start
   address. That pending fallback lasts ten minutes and still uses Routes.
   If Routes itself is unavailable, the assistant offers a later retry or a clearly
   labelled, non-live web estimate instead of inventing current traffic. Diagnostic
   events retain only the failed stage (`places`, `routes`, or `unknown`), numeric
   HTTP status, and a bounded provider reason code; they never include coordinates,
   addresses, keys, request bodies, or provider error prose.

The existing phone one-shot/continuous buttons remain as development and diagnostic
controls. A valid manual or automatic fix is held only in the connected session;
it can be reused while no more than two minutes old. After automatic permission
succeeds, continuous SDK updates refresh that state at most every 10 seconds.
The visible stop-and-clear control immediately removes it.

The desktop Simulator has no phone hardware and is not reviewer parity. Its six
public simulated presets are therefore a **development-only** route source. When a
preset is selected, the local one-shot and continuous buttons emit the labelled
fixed test point instead of calling native GPS. The preset module is excluded from
release builds. A physical-device build must never silently substitute a fictional
coordinate when phone GPS is denied, unavailable, or times out; it falls back to a
spoken or typed origin. Local Testing, Private Testing, and finally Beta Testing are
required to validate the real phone permission and lifecycle path.

The SDK provides coordinates, not traffic-aware travel time. “How long to Costco
from here?” therefore uses Places Text Search (New) to resolve the destination and
Routes Compute Route Matrix for distance/ETA. A Places bias is a ranking hint, not
a route-distance cap or geographic restriction; a destination that includes an
explicit city may override it.
Coverage, regional terms and traffic availability still vary, especially when
travelling in mainland China, and require real travel-region acceptance tests.

Do not promise a “within two metres” address. Phone GPS accuracy varies with the
device, buildings, weather, and permission mode, while reverse geocoding returns an
estimated nearest addressable place rather than proof that the user is at that
address. The intended disclosure policy is:

- use the exact fix only inside the server-side route/geocoding request;
- if reported accuracy is roughly 30 metres or better, show “near” the returned
  street/address together with the accuracy radius;
- for a weaker fix, downgrade to neighbourhood/city or ask for a starting point;
- provide the LLM only a human-readable origin label, accuracy radius, observation
  time, and route result — never the raw latitude/longitude by default.

The current route path does not call reverse geocoding and therefore does not show a
street label for the user's origin. Google Places/Routes require a separately
enabled, billed server-side Maps key restricted to **Places API (New)**,
**Routes API**, and the production server's static egress IP. The existing Google
Calendar OAuth client is not this key. See the dedicated
[Google Maps route setup](setup/GOOGLE_MAPS_ROUTES.md).

The manifest already requests `location`. Real-device tests must still verify the
actual system permission prompt, denial/timeout behavior, foreground/background
lifecycle, travel regions, reported accuracy and cleanup before the feature is
described as generally available.

## Safe self-hosted distribution

The current Private Testing build is personal: its manifest and production bundle
allow only `calendar.eveng2assistant.com`. It contains no server token or provider
credential, but anyone installing that exact package would still be pointed at the
operator's endpoint. Therefore it must not be presented as a general-purpose public
binary.

Even Hub's manifest network whitelist and WebView CORS/Origin checks are independent
security gates. A universal self-hosted binary cannot safely accept arbitrary server
URLs while retaining the current exact-host whitelist. Do not solve this with `*`,
an open Origin policy, a shared access token, or a public port 3001.

Supported distribution modes are therefore:

- **Now — personal Private Testing:** the operator builds and installs a package
  pinned to their own backend and keeps the access token private.
- **Open-source self-hosting:** each operator configures their domain, updates the
  exact manifest whitelist, builds their own `.ehpk`, and supplies their own keys,
  calendar account, mail account, storage, quotas, retention, and backups.
- **Future public Hub listing:** blocked until Even Hub supports a reviewable
  user-configurable endpoint model, or the project intentionally builds a properly
  isolated multi-user service. This project currently chooses neither a wildcard
  whitelist nor the maintainer's personal server as a public relay.

The listing and setup guide must say “self-hosted backend required” before install,
not after a user has already shared data.

## Version placement

- **V1.2 simulator/client:** keep the existing companion text box; add tests for
  typed email/URL/Unicode input, authentication, empty/oversized input, and display
  history. Design structured recipient entry and confirmation without enabling
  arbitrary delivery yet.
- **Current local gate:** finish developer build/tests, then user simulator
  acceptance for automatic one-shot routing, permission notice, three-attempt
  fallback and typed-origin recovery. Do not deploy or repack only because source
  changed.
- **Linux gate:** after local acceptance, provision the restricted Maps key on the
  server, deploy the server-only build, run live route tests, then perform the host
  and key security review.
- **V1.3 real G2:** only after those gates, rebuild the `.ehpk` once and validate the
  phone text box and automatic location path inside the packaged WebView. Test
  allow/deny, stale/low-accuracy fixes, timeout, network switching, travel regions,
  and proof that exact coordinates are not persisted.
- **Post-V1 safety action:** add fixed/allowlisted To/CC recipients with an explicit
  per-send preview and confirmation. Do not let free-form model output directly
  address email.
- **Post-route POC:** Weather and Air Quality may enrich a recommendation only
  after separate-key restrictions, optional parallel execution, privacy review,
  cost limits, and independent failure/back-tests. They are not enabled now.

Official references:

- [Even Hub overview](https://hub.evenrealities.com/docs/get-started/overview)
- [Device APIs](https://hub.evenrealities.com/docs/build/device-apis)
- [Networking](https://hub.evenrealities.com/docs/build/networking)
- [Packaging](https://hub.evenrealities.com/docs/ship/packaging)
- [App Submission and QA](https://hub.evenrealities.com/docs/ship/app-submission)
- [Google Routes API overview](https://developers.google.com/maps/documentation/routes)
- [Places Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search)
- [Google Maps Platform key security](https://developers.google.com/maps/api-security-best-practices)
- [Google reverse geocoding](https://developers.google.com/maps/documentation/geocoding/reverse-geocoding)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
