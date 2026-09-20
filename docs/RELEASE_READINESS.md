# Calendar and delivery development checkpoint

## Verified local scope

- Continuous dialogue, readable HUD pagination and reconnect after exit.
- Dedicated Google Calendar query with notes, conflict checks, compact previews,
  confirmation-gated create/update/cancel and fixed-recipient invitations.
- Retained session drafts are separate from expiring one-use authorization.
- SQLite-backed logical sessions use stable message IDs, rotating scoped resume credentials and a 15-minute reconnect window; a second input client is rejected.
- Sessions can exceed 100 messages. Model input uses a deterministic character budget plus validated asynchronous summaries; interrupted/failed answers remain explicitly unconfirmed.
- Topic-scoped Markdown export freezes immutable selected content and keeps byte, disk and email limits instead of treating 100 messages as a hard document limit.
- Read health/error feedback and bounded retry; uncertain writes are not replayed.
- Confirmed Markdown delivery, calendar attachments and explicit resend protection.
- Source-only repository; separate SDK/simulator dependencies and server-only build.

This is a development checkpoint, not a production or Even Hub approval claim.
The single-user Linux backend has passed host-level deployment and security checks;
physical G2/R1 end-to-end acceptance remains outstanding.

## Ordered deployment acceptance

Keep this sequence so backend, development tooling and the eventual Hub package
remain separate:

1. Run read-only production ingress checks first: HTTPS, authenticated WSS,
   rejected invalid Origin/token, closed public port 3001 and Calendar health.
2. Keep the official simulator local and point its development-only Vite proxy
   at `wss://calendar.eveng2assistant.com`. Exercise text, bilingual speech,
   search, Calendar read, exit and reconnect without opening another server port.
3. Add the packaged client's production WSS endpoint and exact `network`
   whitelist only after the simulator path passes. Do not bundle a client token
   or provider credential.
4. Select the permanent reverse-domain package ID, build and pack an `.ehpk`,
   then use Even Hub Private Testing to validate real manifest permissions.
5. Finish with physical G2/R1 acceptance for microphone, BLE/input timing,
   phone backgrounding and lifecycle behavior before Beta or submission.

The public backend transport and security checks passed on 2026-09-17. The
local simulator-to-production-WSS path subsequently passed bilingual speech,
search, Calendar read/create/update/cancel, confirmed email delivery, exit and
reconnect on 2026-09-18. Production monitoring, automatic updates, verified
daily backup and an isolated restore drill also passed. These results still do
not certify physical hardware or phone lifecycle behavior.

The packaged client now has an exact production HTTPS/WSS whitelist, a direct
production WSS target, release-safe display name and reverse-domain identity.
SDK tests and release-content scanning pass, and the official CLI produced a
45,803-byte `0.1.0` `.ehpk` with `min_app_version 2.2.9`. The artifact remains
local and Git-ignored. Package-ID availability needs an explicit CLI login;
portal upload, packaged WebView Origin validation, Private Testing and physical
G2/R1 acceptance remain outstanding.

After adding the manual location transport POC, the same pinned CLI produced a
47,024-byte `0.2.0` candidate with `min_app_version 2.2.9` and SHA-256
`C227476FA2AB398A0C5382EAD325C4BDE3ED0ECCD443995077E2DFA4E3FA96E6`.
It is also local and Git-ignored; this build has not been uploaded or certified
on a real phone/G2.

## Recurring meetings: bounded first implementation

Google supports a recurring parent event with `recurrence` (RRULE), an IANA
timezone and attendees. `sendUpdates=all` requests attendee notifications.
Our queries already use `singleEvents=true`, so occurrences in the requested
date range are visible. Timed daily/weekly series with finite count (2–366),
interval (1–12) and span at most 366 days can now be created with confirmation.
Single-occurrence and entire-series update/cancel use original Google IDs and
notify the fixed recipient. Read-only/external events remain protected.

Implemented safety and outstanding boundaries:

1. Bounded daily/weekly RRULE validation and plain-language preview. Unspecified
   or open-ended requests default server-side to three calendar months from the
   first date, disclosed in notes and preview, never auto-renewed. Explicit local
   ending dates convert to finite counts. Monthly, multiple weekdays and all-day
   series remain unsupported.
2. Create one recurring parent, not a batch of independent meetings. Retain its
   Google ID and iCalUID; invite the configured recipient after confirmation.
3. Explicitly distinguish **this occurrence** and **entire series (including past)**.
   **This and following** remains unsupported: it requires transactional recovery
   for a two-write split, not silently choosing a different scope.
4. Check every proposed occurrence, batching queries into windows of at most 31
   days. DST tests preserve local start; ambiguous/nonexistent starts fail closed.
5. Mock tests cover invitations, instance/series changes, cancellation and stale
   approvals. Real recurring Google writes/invitation receipt are not yet tested.
   Standalone recurring ICS export remains unsupported and fails explicitly;
   native Google Calendar handles series invitations. Single-event ICS is unchanged.

References checked 2026-09-16:
- [Google recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
- [Google events.insert and sendUpdates](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

## Even Hub publication target

Keep the packaged SDK client separate from the private server runtime. The
production endpoint, manifest whitelist and debug-free bundle are now configured.
Before submission: validate real-device lifecycle and document data flows, retention,
deletion, support and privacy practices. Never ship provider keys,
OAuth refresh tokens or operator email credentials in the client package.

The current backend is a personal, single-owner deployment. The selected public
distribution model is user-operated backends, not a shared multi-user service.
Each operator manages their own credentials, storage and quotas. Publishing
the client must not expose the operator's private calendar or shared access token.
Google public OAuth readiness is a separate gate from Even Hub review.

The current `.ehpk` is pinned to the maintainer's exact backend origin and is for
personal Private Testing only. It must not be uploaded as a general public binary:
an installer would otherwise be directed to the maintainer's service. Even Hub's
static network whitelist also means a text field cannot turn this package into a
safe arbitrary-self-host client. Each self-hoster must rebuild with their own exact
origin unless the platform later provides a reviewable endpoint-configuration model.
Wildcards, open Origin checks and a shared maintainer token are not acceptable.

The phone companion text box is already present. Source after the existing `0.2.0`
package now adds automatic session-only location, three bounded first/stale-fix attempts,
typed-origin fallback, Places candidate ratings, traffic-aware Route Matrix
comparison, confidence-adjusted recommendation, and drive/walk/cycle session modes.
Coordinates bypass the LLM/history/logs, refresh at most every 10 seconds, and are cleared on explicit stop, disconnect or session exit. Mocked
tests pass, but this source has deliberately not been deployed or repacked yet. See
[companion input, location, and safe distribution](COMPANION_INPUT_LOCATION_AND_DISTRIBUTION.md)
and [Google Maps route setup](setup/GOOGLE_MAPS_ROUTES.md).

## Current location release gate

Do not reorder or collapse these steps:

1. Developer local typecheck, unit/integration tests, server-only build, SDK test/build,
   public-source scan and manual diff review. Completed for this local POC on
   2026-09-18; no live Google request was made by the automated gate.
2. User local simulator acceptance, including first permission guidance, success,
   nearby candidate/rating display, drive/walk/cycle recalculation, three-attempt
   failure, typed-origin fallback, interruption and exit.
3. Only after that approval, configure the restricted server Maps key, deploy the
   server-only release to Linux and perform live route tests.
4. Run the post-deployment security review: public ports, loopback, HTTPS/WSS,
   Origin/token rejection, secret permissions, service sandbox, key/API/IP
   restrictions, quotas/alerts and coordinate-free logs.
5. Perform other travel-region and failure tests. Only when all preceding gates are
   ready should a final `.ehpk` be rebuilt for Private Testing and real G2/phone
   permission/lifecycle acceptance.

Weather, Air Quality and transit are separate later gates. They are not enabled by
this POC and must not be inferred from the route result.

Separate control-plane requirement: set the OpenAI project's monthly spend limit to `$50`
and enable hard enforcement in the API dashboard. Application search limits are
10/answer, 50/session, 100/day and 1200/calendar-month, but they do not cap all API,
Maps or AWS charges.

Even Hub publication requires platform review; no approval is implied here.
- [Even Hub developer terms](https://support.evenrealities.com/hc/en-us/articles/15606676690703-Even-Hub-Developer-Platform-Terms-of-Service)
- [Even Hub documentation](https://hub.evenrealities.com/docs/guides/networking)

## Public source release checks

Run unit tests, type checks, SDK build/tests and the server-only build. Audit the
worktree, staged blobs and reachable Git history before pushing; audit again
afterwards. The scanner checks prohibited paths, credential patterns, private
email addresses, personal Windows paths and exact locally configured secrets.
Historical audit covers file contents, not Git author metadata. Existing public
commit author identities are not rewritten by this checkpoint. Automated scans
cannot prove the absence of every secret or private fact; review the file list.
Never run live mail/calendar mutation scripts as part of CI or a release audit.
