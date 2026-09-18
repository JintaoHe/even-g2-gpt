# Companion input, location, and safe distribution

Status: design decision recorded on 2026-09-18. The phone text input already
exists in the SDK client. Location and arbitrary-recipient delivery are planned,
not implemented in the current `0.1.0` package.

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

The first implementation should be deliberately narrower than the SDK permits:

1. request a **one-shot** high-accuracy location only after an explicit route,
   nearby-place, or current-location question;
2. show a clear phone permission prompt and a concise glasses status;
3. apply a short timeout and ask the user for a city or starting point if location
   is denied, stale, inaccurate, or unavailable;
4. send coordinates to a server-side routing provider over WSS; do not place a map
   key in the `.ehpk`;
5. give the LLM a structured route result (origin label, destination, duration,
   distance, traffic basis, and observation time) instead of raw coordinates unless
   raw coordinates are genuinely required;
6. do not retain exact location in conversation history, logs, analytics, or MD
   exports by default; redact coordinates from errors;
7. do not start continuous/background tracking in the first release.

The SDK provides coordinates, not traffic-aware travel time. “How long to Costco
from here?” additionally needs a route provider. A provider choice must be evaluated
for current-traffic coverage, cost caps, key restrictions, retention terms, China
availability, and travel-region behavior before implementation.

The current `0.1.0` manifest does **not** request location. Add it only when the
feature, denial fallback, privacy text, and real-device tests are ready.

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
- **V1.3 real G2:** validate the phone text box inside the packaged WebView. Add a
  location proof of concept only after the voice/WSS/lifecycle matrix passes; test
  allow/deny, stale/low-accuracy fixes, timeout, network switching, travel-region
  behavior, and proof that exact coordinates are not persisted.
- **Post-V1 safety action:** add fixed/allowlisted To/CC recipients with an explicit
  per-send preview and confirmation. Do not let free-form model output directly
  address email.

Official references:

- [Even Hub overview](https://hub.evenrealities.com/docs/get-started/overview)
- [Device APIs](https://hub.evenrealities.com/docs/build/device-apis)
- [Networking](https://hub.evenrealities.com/docs/build/networking)
- [Packaging](https://hub.evenrealities.com/docs/ship/packaging)
- [App Submission and QA](https://hub.evenrealities.com/docs/ship/app-submission)
