# Fixed-recipient Markdown delivery

API conversations can generate a requested standalone Markdown artifact (plan, engineering specification/code as text, instructions, steps, discussion points, selected answer or transcript), or an MD plus ICS calendar draft. Generation and sending are separate. The assistant previews the saved filename/summary/event details and asks for confirmation; it never treats the original request to generate-and-send as permission to skip this preview. CLI conversations retain the manual web export/email workflow; they do not silently make paid API drafting calls.

## Conversational confirmation

The existing API intent request also classifies delivery intent; normal turns do not add another classifier request. Draft generation uses one bounded Responses request (60 seconds, 7000 output tokens, no tools/search, `store:false`) using `OPENAI_DOCUMENT_MODEL` or the reply model. It uses only the supplied conversation and prior draft, not server files, credentials or a shell. Ordinary token charges apply independently of the search quota. Oversized context, incomplete outputs, refusal or save failure stop the operation rather than substituting a conversation transcript.

After successful durable save, the assistant asks the user to say **确认发送** (English: **send it**). Both semantic confirmation intent AND a short explicit send phrase are required; an ambiguous “好”, quoted phrase, negation or combined correction/approval cannot send. Confirmation is bound to the exact latest preview and artifact in the current session, expires after five minutes, and is consumed before sending. Topic changes, pause, exit, disconnect or a new generation invalidate the pending approval. A later confirmation first re-previews the file rather than sending silently. Model intent recognition remains fallible; the explicit phrase and backend state are additional safeguards, not a guarantee of perfect STT.

Corrections create a new immutable artifact; old versions remain downloadable but are marked superseded and cannot be emailed. The new version needs fresh confirmation. The user can ask to review the full draft or cancel sending. No email is sent during generation. Once SMTP submission has started, interruption cannot guarantee recall; its result remains in the durable delivery ledger. No automatic resend is performed.

Saved drafts remain available after restart, but conversational approvals do not survive; use the web preview/confirmation flow to deliver a saved artifact. Engineering files in this version are Markdown specifications or code blocks, not arbitrary executable files or project archives.

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
- Each artifact is attempted only once. Repeated clicks do not send it again. SMTP transport requeues are disabled.
- `accepted` means the SMTP server accepted the message, **not proof of inbox delivery**. Check spam too.
- `failed` means a definite authentication/recipient failure; `unknown` means delivery cannot safely be ruled out, including timeout or crash. Neither is automatically retried. Check the mailbox and fix configuration before explicitly exporting a new artifact if another attempt is wanted. Message-ID is stable but is not an exactly-once delivery guarantee.
- SMTP has a 20-second overall deadline and shorter connection timeouts. Graceful shutdown waits for the attempt; interrupted delivery is marked unknown on the next start. Failed delivery never removes the saved MD.
- No raw SMTP errors, protocol logs, credentials or recipient details are returned to the browser/model. The application enforces fixed recipients; an app password itself is broader authorization and must remain private.

## Manual synthetic smoke test

Run `node --import tsx scripts/mail-smoke.ts --send` manually from the repository root, using the supported Node runtime and system CA configuration as needed. This explicit command overrides the enable flag **only for its synthetic test**, uses no model API, and sends one non-private Markdown attachment. Its separate `.local/mail-smoke` ledger prevents reruns from resending the same test artifact. Do not delete that ledger to retry an uncertain send without first checking the mailbox. This script is excluded from CI test discovery and the server-only release.

Credentials are not included in Linux builds. Deploy and back up the private data/config separately. SMTP connectivity and process lifecycle still need validation on the chosen Linux host.

Only after explicitly authorizing a fresh test, add `--new-test` to create a new synthetic artifact; this is a new send, not a retry of the previous ambiguous delivery.
