# Calendar and delivery development checkpoint

## Verified local scope

- Continuous dialogue, readable HUD pagination and reconnect after exit.
- Dedicated Google Calendar query with notes, conflict checks, compact previews,
  confirmation-gated create/update/cancel and fixed-recipient invitations.
- Retained session drafts are separate from expiring one-use authorization.
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
