# Fixed-recipient Markdown delivery

This first version sends an already completed conversation-export artifact. It does not yet implement voice-triggered document generation, AI summarization, arbitrary recipients, or automatic sending after every answer. API and CLI conversation providers use the same backend delivery code.

## Private setup

Use a dedicated Gmail account with two-step verification and an app password. Copy the empty mail fields from `.env.example` to private `.env`, or the Linux service's protected EnvironmentFile. Set `SMTP_USER` and `EMAIL_FROM` to the dedicated sender, `EMAIL_TO` to one fixed recipient, and `SMTP_PASS` to the app password. Never use the Google login password. Keep credentials and real addresses out of source, tests, issues and logs. Set `EVEN_EMAIL_ENABLED=true` and restart the backend to enable sending.

Only `smtp.gmail.com` is supported: port 465 with `SMTP_SECURE=true` uses implicit TLS; port 587 with `SMTP_SECURE=false` requires STARTTLS before authentication. Both verify certificates and require TLS 1.2 or later. The recipient mailbox needs no authorization. Gmail/account restrictions and server outbound SMTP policies may still prevent delivery. Do not disable TLS verification or two-step verification to work around failures.

## Usage and safety

In the browser conversation lab, export the current conversation to MD, then choose **发到固定邮箱** on a completed artifact and confirm. Downloads remain available independently. The authenticated WebSocket command is `jobs.email` with an existing job `id` only: no recipient, subject, attachment path, URL or arbitrary message fields are accepted. Only the private server configuration chooses the address. Attachment content is read through the validated artifact store; external file and URL loading are disabled in the mail transport.

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
