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
Linux deployment and physical G2/R1 acceptance remain outstanding.

## Recurring meetings: feasible, not implemented for writes

Google supports a recurring parent event with `recurrence` (RRULE), an IANA
timezone and attendees. `sendUpdates=all` requests attendee notifications.
Our queries already use `singleEvents=true`, so occurrences in the requested
date range are visible. The current write guard rejects both recurring parents
and occurrences; the planner and event schema only support single events.
Do not promise recurring creation or silently replace it with a single meeting.

Suggested follow-up implementation (not enabled by this checkpoint):

1. Structured daily/weekly recurrence with interval, weekdays and an explicit
   end date or count; validate rules server-side and preview in plain language.
2. Create one recurring parent, not a batch of independent meetings. Retain its
   Google ID and iCalUID; invite the configured recipient after confirmation.
3. Explicitly distinguish **this occurrence**, **entire series**, and **this and
   following** for updates/cancellations. The last option requires splitting a
   series; handle partial failure without automatic duplicate creation.
4. Check conflicts over a bounded, disclosed date horizon. Test DST so a Chicago
   9 AM meeting remains 9 AM when the UTC offset changes.
5. Test attendee updates, exception instances, cancellation, retry/idempotency
   and RRULE-aware ICS fallback. Real invitations need separate test approval.

References checked 2026-09-16:
- [Google recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
- [Google events.insert and sendUpdates](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

## Even Hub publication target

Keep the packaged SDK client separate from the private server runtime. Before
submission: validate real-device lifecycle, configure a production HTTPS/WSS
endpoint, remove local debug configuration, and document data flows, retention,
deletion, permissions, support and privacy practices. Never ship provider keys,
OAuth refresh tokens or operator email credentials in the client package.

The current backend is a personal, single-owner deployment. Public distribution
must choose either user-operated backends or a separately designed multi-user
service with per-user authorization, credentials, storage and quotas. Publishing
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
