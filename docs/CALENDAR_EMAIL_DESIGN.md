# Calendar email: confirmed ICS attachments

The web lab can now attach one confirmed event to a conversation export. Expand the calendar form, enter title, start/end, IANA timezone and optional location/notes, then confirm export. Timed values require explicit offsets (for example `2026-09-20T14:00-05:00` in `America/Chicago`). The server rejects impossible dates, missing offsets, mismatched timezone offsets and reversed intervals. DST repeated hours require an explicit correct offset; nonexistent hours are rejected. All-day events use dates and an exclusive end date, without a timezone.

Export does not send email. The completed task shows the persisted event; the separate fixed-recipient email confirmation includes these details. Email contains MD plus a descriptively named ICS attachment and visible event details. The web lab supports authenticated MD and ICS downloads as a fallback when email does not arrive. Event data lives in the existing private SQLite store; ICS bytes are generated deterministically using the job UUID and creation timestamp. A separately confirmed resend preserves those exact bytes and is limited to once per artifact, counting toward the daily mail quota. No additional model call or calendar credential is needed to resend/download.

API conversations also support explicit calendar drafting requests. Missing start/end, ambiguous relative dates or DST times trigger clarification rather than invented defaults. The configured `CONVERSATION_TIMEZONE` is used unless the user specifies another zone and is shown in the preview. After saving the draft, the assistant shows the absolute dates/times/zone and requests a separate “确认发送”. The ICS is generated only from validated event fields. See EMAIL_DELIVERY.md for the per-session confirmation state machine and version invalidation.

Recurring events, updates/cancellations of already imported events, automatic calendar writes and notification alarms are NOT implemented. “Calendar reminder” means an importable event, not a scheduled notification service; the preview explicitly states that no alarm is included. A conversation merely mentioning a date does not create an event. Invalid input creates no job. Gmail/Apple client rendering and real-device import still require manual acceptance testing; unit tests do not prove an Add to Calendar button appears.

## Do not rely on inferred events

Gmail's Events from Gmail feature supports specific confirmation categories (flights, hotels, restaurants, ticketed events), subject to account settings and eligibility. A personal assistant's generic conversation summary is not a reliable way to trigger it. Gmail's structured reservation markup also has sender registration requirements; do not pretend a suggestion is a confirmed booking.

Apple documents Siri suggestions from Mail, Messages and Safari. Whether a particular personal email gets a suggestion is controlled by the receiving client and user settings, not guaranteed by our sender.

## Confirmation policy and future voice integration

Only after the user explicitly asks for a calendar item: collect a descriptive title, absolute date, start/end or all-day status, timezone, and optional location/notes. Resolve ambiguous relative dates and daylight-saving times with the user before creating the file. Show the interpreted event and obtain confirmation before email delivery.

Attach a standard `.ics` iCalendar file alongside the MD with a meaningful filename. Show the same event details and timezone in the email body. The recipient imports it and chooses their calendar (including their iCloud calendar where the client supports it). Test Gmail web/iOS and Apple Mail separately: the availability and placement of an Add to Calendar button are client-dependent.

Use stable event UIDs, escaped iCalendar text and correct UTF-8 line folding; distinguish timezone-aware timed events from all-day dates. Do not add alarms, attendees, subscriptions, invitation RSVP requests or external attachments by default. Do not automatically resend/import updates: stable UIDs alone do not guarantee deduplication across manual imports and clients. Explicit update/cancellation semantics need a separate design.

This flow needs no iCloud account credential and grants the agent no calendar read/write permission. It is an importable file, not a silent write into the user's calendar. Automatic synchronization or editing existing events would require a separately authorized calendar integration.

## Official references

- [Google: Events from Gmail and limitations](https://support.google.com/calendar/answer/6084018?hl=en)
- [Google: Registering a markup sender](https://developers.google.com/workspace/gmail/markup/registering-with-google)
- [Apple: Event suggestions from other apps](https://support.apple.com/guide/iphone/create-and-edit-events-in-calendar-iph3d110f84/ios)
- [Apple: Import calendar files on Mac](https://support.apple.com/guide/calendar/import-or-export-calendars-icl1023/mac)
