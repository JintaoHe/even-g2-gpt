# Fixed-recipient Markdown delivery

API conversations can generate a requested standalone Markdown artifact (plan, engineering specification/code as text, instructions, steps, discussion points, selected answer or transcript), or an MD plus ICS calendar draft. Natural requests such as “把刚才这份计划发到我的邮箱” count as document requests even when the user does not say Markdown or MD. Generation and sending are separate. The assistant previews the saved filename/summary/event details and asks for confirmation; it never treats the original request to generate-and-send as permission to skip this preview. CLI conversations retain the manual web export/email workflow; they do not silently make paid API drafting calls.

## Conversational confirmation

The existing API intent request also classifies delivery intent; normal turns do not add another classifier request. Draft generation uses one bounded Responses request (60 seconds, 7000 output tokens, no tools/search, `store:false`) using `OPENAI_DOCUMENT_MODEL` or the reply model. It uses only the supplied conversation and prior draft, not server files, credentials or a shell. Ordinary token charges apply independently of the search quota. Oversized context, incomplete outputs, refusal or save failure stop the operation rather than substituting a conversation transcript.

After successful durable save, the assistant asks the user to confirm the exact preview. **确认发送** / **send it** remains the clearest phrase. Short contextual assent such as **好，可以**、**可以** or **没问题** is also accepted only when it immediately follows the current formal preview and matches its server-held, unexpired approval. A bare “好的”, quoted phrase, negation, question, correction, recipient change or combined correction/approval cannot send. With no formal preview, none of these phrases can create an artifact or send mail. Confirmation is bound to the exact latest preview and artifact in the current session, expires after five minutes, and is consumed before sending. Topic changes, pause, exit, disconnect or a new generation invalidate the pending approval. A later confirmation first re-previews the file rather than sending silently. Model intent recognition remains fallible; the immutable preview and backend state—not ordinary assistant wording—are the authority.

If the intent model mistakes a natural “send this plan to my email” request for a confirmation before any artifact exists, the delivery layer recovers it as a document-generation request. It saves the artifact and shows the formal preview first; it never sends in that same turn. Ordinary Luna replies are not allowed to invent a delivery preview or imply that a send-ready draft exists.

Corrections create a new immutable artifact; old versions remain downloadable but are marked superseded and cannot be emailed. The new version needs fresh confirmation. The user can ask to review the full draft or cancel sending. No email is sent during generation. Once SMTP submission has started, interruption cannot guarantee recall; its result remains in the durable delivery ledger. No automatic resend is performed.

Saved drafts remain available after restart. The API conversation reconnects the session to the completed immutable JobStore artifact, but conversational approvals do not survive: the first send request after a cold start only shows a fresh preview, and a later separate confirmation can send. A prior `sending`/`unknown`/`accepted` mail ledger state is reported rather than replayed. The web preview/confirmation flow remains available independently. Engineering files in this version are Markdown specifications or code blocks, not arbitrary executable files or project archives.

## Presentation and summary

New exports store a title/summary beside the job in SQLite; the summary is also included above the full conversation in the MD. Original conversation text and source URLs remain intact. Internal disk filenames remain UUIDs for safe lookup; the user-facing attachment and browser download use a sanitized topic title. Existing artifacts without metadata retain a generic title and explanation; regenerate the export to get the new presentation. Already delivered emails are never changed or resent.

In API mode, `EMAIL_AI_SUMMARY=true` (default) adds one bounded Responses request per export, using `EMAIL_SUMMARY_MODEL` or the intent model. It uses no tools/search, `store:false`, a 10-second timeout and 700 output-token limit. Ordinary model token charges apply. Only up to 24,000 characters of the conversation are sent for this summarization; the full MD remains intact. Summaries of truncated input are explicitly described as partial. Model output is untrusted: title and filename lengths are capped, controls/path separators are removed, and HTML is escaped. No remote images, login buttons or tracking links are embedded.

Set `EMAIL_AI_SUMMARY=false` to avoid the additional API call. CLI mode, API failures/refusals, and unavailable keys use a clearly labelled **内容摘录（非 AI 总结）** instead. These summaries/excerpts are review aids, not new factual verification or evidence that a proposed plan was confirmed. Credential/recipient handling and send confirmation are unchanged.

Run `node --import tsx scripts/mail-preview.ts` for a synthetic local HTML/MD preview, or add `--ai` for one real summary call. It never sends email. Preview output stays under ignored `.local/mail-preview` and is excluded from server releases.

Run `node --import tsx scripts/delivery-eval.ts` for an opt-in real-model evaluation using synthetic dialogue. It checks standalone drafting, confirmation routing, calendar clarification and a mocked sender; it NEVER instantiates SMTP or sends email. It incurs model token usage and saves synthetic outputs under ignored `.local/delivery-eval-*`.

## Private setup

Use a dedicated Gmail account with two-step verification and an app password. Copy the empty mail fields from `.env.example` to private `.env`, or the Linux service's protected EnvironmentFile. Set `SMTP_USER` and `EMAIL_FROM` to the dedicated sender, `EMAIL_TO` to one fixed recipient, and `SMTP_PASS` to the app password. Never use the Google login password. Keep credentials and real addresses out of source, tests, issues and logs. Set `EVEN_EMAIL_ENABLED=true` and restart the backend to enable sending.

Only `smtp.gmail.com` is supported: port 465 with `SMTP_SECURE=true` uses implicit TLS; port 587 with `SMTP_SECURE=false` requires STARTTLS before authentication. Both verify certificates and require TLS 1.2 or later. The recipient mailbox needs no authorization. Gmail/account restrictions and server outbound SMTP policies may still prevent delivery. Do not disable TLS verification or two-step verification to work around failures.

## Usage and safety

In the browser conversation lab, export the current conversation to MD, then choose **预览并确认发送** on a completed artifact. Downloads remain available independently. `jobs.email.prepare` with a saved `id` returns server-held preview data and a one-use, five-minute session confirmation token. Only a subsequent `jobs.email` with that `id` and `confirmation` can send; a bare send request is refused. Cancelling the dialog revokes the token. New speech/text, export, pause or exit invalidate the pending manual approval. No recipient, subject, attachment path, URL or arbitrary message fields are accepted. Only private server configuration chooses the address. Attachment content is read through the validated artifact store; external file and URL loading are disabled in the mail transport.

- Delivery attempts are recorded in `jobs.sqlite` before SMTP, survive disconnect/restart and are limited to 20 per UTC calendar day. At most one send runs at once.
- Each artifact permits one initial attempt and at most ONE separately confirmed resend. Repeated initial confirmations or replayed retry approvals never resend. Both attempts count toward the daily limit; attempts and recipient-reported receipts persist across restart. SMTP transport requeues are disabled.
- `accepted` means the SMTP server accepted the message, **not proof of inbox delivery**. Check spam too.
- `failed` means a definite authentication/recipient failure; `unknown` means delivery cannot safely be ruled out, including timeout or crash. Neither is automatically retried. Each authorized attempt has its own persisted Message-ID; the artifact and ICS event UID/DTSTAMP remain unchanged on resend. Duplicate mail/imports are still possible and disclosed before retry.
- SMTP has a 20-second overall deadline and shorter connection timeouts. Graceful shutdown waits for the attempt; interrupted delivery is marked unknown on the next start. Failed delivery never removes the saved MD.
- No raw SMTP errors, protocol logs, credentials or recipient details are returned to the browser/model. The application enforces fixed recipients; an app password itself is broader authorization and must remain private.

## Receipt and recovery

For calendar attachments, the generic send/resend phrases below are replaced by explicit primary-timezone/date approval (see CALENDAR_EMAIL_DESIGN.md). The manual send payload additionally requires `calendar_confirmation`, validated on the server; it is not a recipient or message-content override.

After SMTP acceptance, the assistant says the email was successfully submitted to the mail server and asks whether it arrived; it does not claim verified inbox delivery. A separate status notice is also emitted if the conversation was interrupted during SMTP submission. Disconnected clients can inspect the persisted file-list status after reconnecting.

“没收到” / a request to resend first offers spam/all-mail checks and a warning about delayed duplicate delivery, then asks for **确认重发** / **resend it**. Only that separate explicit confirmation can retry the same immutable artifact once. Ambiguous assent, an expired approval, cancellation or a superseded artifact cannot trigger a retry. “收到了” records a **user-reported** receipt (not an email read receipt) and suppresses further retries. No inbox-reading permission or tracking pixel is added.

The web lab offers “我已收到” and “没收到／预览重发”. `jobs.email.prepare` can include `retry:true`; the server binds its token to the current attempt number. `jobs.email` still accepts only the existing `id` and the one-use `confirmation`, not retry counts supplied by clients. `jobs.email.received` records explicit user feedback for the selected saved artifact.

Fallback: authenticated MD and ICS downloads remain available independently of SMTP. `GET /artifacts/:id/calendar` uses the same bearer authentication and safe attachment headers as the MD endpoint, and generates the exact same calendar bytes as email. These are not public share links. The server-only Linux package does not include the web lab: use a separately deployed authenticated client for downloads. Once a retry is exhausted, suggest downloads/configuration checks rather than generating a fresh artifact to bypass the limit.

## Manual synthetic smoke test

For the three-format acceptance suite, explicitly authorize each real email first, then run `node --import tsx scripts/mail-acceptance.ts --case md --send`, or `--case ics` / `--case both` with `--confirm-chicago-test-time` after confirming its documented synthetic date (2026-10-01, 18:00–18:15 America/Chicago). These send real mail to the private fixed recipient; no model request or private conversation is used. The separate `.local/mail-acceptance-v1/<case>` ledgers prevent accidental reruns. Do not delete their ledgers to retry uncertain delivery. ICS-only mode is an explicit sender-factory option used by this test; normal conversation delivery still defaults to MD plus optional ICS.

All formats include a descriptive subject, plain-text/HTML summary, actual attachment names and the honest display identity **Even Assistant · 系统通知**, using the configured dedicated Gmail address. This identifies our own application's automated notification, not a Google/Apple/Even vendor message. No spoofed sender domain, login link or tracking image is added. Calendar test content is prominently labelled as a non-real arrangement without alarms or automatic import.

Run `node --import tsx scripts/mail-smoke.ts --send` manually from the repository root, using the supported Node runtime and system CA configuration as needed. This explicit command overrides the enable flag **only for its synthetic test**, uses no model API, and sends one non-private Markdown attachment. Its separate `.local/mail-smoke` ledger prevents reruns from resending the same test artifact. Do not delete that ledger to retry an uncertain send without first checking the mailbox. This script is excluded from CI test discovery and the server-only release.

Credentials are not included in Linux builds. Deploy and back up the private data/config separately. SMTP connectivity and process lifecycle still need validation on the chosen Linux host.

Only after explicitly authorizing a fresh test, add `--new-test` to create a new synthetic artifact; this is a new send, not a retry of the previous ambiguous delivery.
