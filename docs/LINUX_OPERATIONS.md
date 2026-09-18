# Linux lifecycle, durable jobs and artifacts

Implemented foundation, single-host/single-user deployment. Windows automated tests pass; an actual Linux deployment is still required before claiming production readiness. Requires Node 24+ (built-in SQLite).

## Process lifecycle

- Node service stays running; CLI starts only when a submitted turn needs classification or an answer. Each invocation exits when done.
- Every runner tracks in-flight operations. Shutdown refuses new CLI work, aborts current operations and waits for process closure. Speech interruptions remain turn-scoped.
- SIGINT and SIGTERM stop the listener and clients, cancel conversational work, stop the background worker and flush conversation writes. A 25-second shutdown deadline prevents indefinite shutdown.
- `deploy/even-agent.service` is a systemd template, not installed automatically. Its control-group kill policy and 30-second stop timeout terminate remaining descendants, including detached CLI process groups, if Node crashes or cleanup fails. Restart is rate-limited.
- Do not run multiple workers against one data directory. SQLite records the owner PID/hostname; a second live owner is rejected. A dead same-host owner can be reclaimed. Unknown ownership, other hosts or PID reuse fail closed and require operator review; never kill a PID merely because it appears in this database.

## Storage

Set `EVEN_DATA_DIR=/var/lib/even-agent` on Linux (local default `.local`). Keep application code under `/opt/even-agent` and account auth under the service user's private Codex home; never expose auth via the web server.

```
/var/lib/even-agent/
  jobs.sqlite          task states and queued snapshots
  jobs.sqlite-wal      SQLite transaction log when present
  jobs.sqlite-shm      SQLite coordination file when present
  conversations/      saved dialogue JSON
  search-usage.json    API-only search quota ledger
  artifacts/          UUID.md completed output; UUID.part temporary output
```

The job type is conversation-to-Markdown export with a title and short summary above the full original conversation (not Word/PDF generation). Use the webpage's “导出当前对话为 MD” button. It snapshots committed history; an answer still being generated is not included until committed. API mode adds one bounded summary request by default; set `EMAIL_AI_SUMMARY=false` for a labelled local excerpt with no extra request. CLI mode uses excerpts. Files are written by the application, not by giving Codex filesystem-write tools. See [email presentation and delivery](EMAIL_DELIVERY.md).

When migrating an existing installation, copy the complete data directory while stopped, including search-usage.json; changing EVEN_DATA_DIR to an empty location does not automatically migrate prior history or quota usage.

- Queued/running exports continue after browser disconnect; reconnect to list jobs/download completed output.
- Queued exports resume after service restart. Running exports become interrupted; they are not automatically replayed. Failed/interrupted tasks require a new explicit export.
- Publication order: write exclusive temporary file → fsync → rename → sync directory on Linux → mark completed in SQLite. Partial/unpublished files are never downloadable. Orphans are retained conservatively and counted against storage usage; no automatic destructive cleanup.
- Limits: 20 pending jobs, 1,000 total records, 2 MiB input/output per export, 50 MiB artifact-directory contents. Conversation logs and SQLite storage are separate; a filesystem quota/backup/retention plan is still required.
- Task cancellation is explicit. The stored snapshot is discarded on cancellation/completion/failure, but already created partial output may remain inaccessible until operator cleanup. No automatic expiration/deletion is implemented.
- Downloads require the same application token as the WebSocket, supplied in an Authorization header (never URL query). The token stays only in page memory. Files are served as attachments with nosniff/no-store; no public static artifact directory. This is one trusted user's installation, not tenant isolation for a public multi-user service.

## Linux setup checklist

Build with `npm run build:server` and deploy only the resulting successful `dist/server-*` directory's contents. Run `npm ci --omit=dev` on Linux. The systemd template now starts compiled `src/conversation-server.js`; do not deploy the source checkout. See [project boundaries](PROJECT_STRUCTURE.md). The server-only release intentionally excludes the browser lab and all SDK/simulator/test code.

1. Provision an unprivileged `even-agent` user with home `/home/even-agent`, Node 24+ and a compatible native Codex CLI. Install dependencies in `/opt/even-agent`. Verify the node path in the unit.
2. Create `/home/even-agent/.codex` with permissions 0700 owned by that user. Log in as that same user using `codex login --device-auth`, then verify `codex login status`. Do not copy a Windows credential file into the repository or image. Login storage must be persistent and writable for credential refresh.
3. Create `/etc/even-agent.env` with mode 0600, readable by the service manager, containing G2_CLIENT_TOKEN and selected provider/model settings. Include OPENAI_API_KEY only when API dialogue or speech is desired. Use an absolute CODEX_CLI_PATH if CLI is not on the service PATH. The unit's ReadWritePaths assumes the Codex auth directory above; adjust explicitly if your installation differs.
4. Review/install the systemd unit, reload the manager and start the service. The listener remains bound to `127.0.0.1`. For production, set `EVEN_PUBLIC_HOST=calendar.eveng2assistant.com` and `EVEN_PUBLIC_ORIGIN=https://calendar.eveng2assistant.com`, then place the included Caddy configuration in front of it. Only ports 80/443 should be public; never expose port 3001. The root domain and unrelated subdomains remain unassigned.
5. Confirm text conversation, job export/download, disconnect/reconnect, SIGTERM shutdown, forced service restart, login persistence and absence of leftover CLI children on Linux. Host bootstrap, security updates, reboot recovery, SSH hardening, UFW, Node 24 and Caddy installation were verified on the target Lightsail instance on 2026-09-17; application secrets, service startup, public TLS and end-to-end client behavior remain pending.
6. Back up while stopped, or use a SQLite-aware consistent backup; do not blindly copy only the main SQLite file while WAL is active. Protect snapshots, transcripts and documents as private data. Container installations must mount persistent data/auth volumes and forward termination signals.

## Production ingress boundary

- `calendar.eveng2assistant.com` is the sole public host for the calendar deployment. Google OAuth homepage and privacy-policy URLs use this subdomain; other Even G2 features should receive separate subdomains and services.
- The checked-in `deploy/Caddyfile` terminates HTTPS, serves the small public information site, and proxies only `/ws/conversation` and `/artifacts/*` to loopback. It adds HSTS, CSP, frame, MIME-sniffing, referrer and permissions-policy headers.
- The Node server rejects unconfigured Host and browser Origin values. Missing Origin remains allowed for native clients, but the application token is still required immediately after WebSocket connection.
- Google may require the registrable domain `eveng2assistant.com` in its Authorized domains field even though the actual homepage, privacy page and application endpoint are confined to `calendar.eveng2assistant.com`.

## Host and network hardening

Apply both the Lightsail IPv4/IPv6 firewall and Ubuntu's host firewall before copying any credentials or personal data to the instance. The intended inbound surface is:

| Port | Source | Purpose |
| --- | --- | --- |
| TCP 80 | Any | ACME validation and HTTP-to-HTTPS redirect only |
| TCP 443 | Any | HTTPS and WSS through Caddy |
| TCP 22 | A reviewed administrator CIDR and/or Lightsail browser SSH only | Key-based administration |

Do not add inbound rules for 25, 465, 587, 3001, 3002, database ports or an unrestricted port range. Gmail SMTP is an **outbound** connection on exactly one configured TLS port (465 or 587); OpenAI and Google Calendar are outbound HTTPS. The Node listener and Google authorization callback remain on loopback. Apply equivalent IPv4 and IPv6 rules because Lightsail manages the two firewalls independently.

On Ubuntu, set the default host-firewall policy to deny incoming and allow outgoing, add the reviewed SSH rule before enabling it, then allow 80/443. Keep SSH public-key authentication enabled, disable password authentication and direct root login, and install unattended security updates. A dynamic travel IP can invalidate a narrow SSH CIDR; update the outer Lightsail rule deliberately rather than leaving TCP 22 open to the world.

The supplied systemd unit drops Linux capabilities, blocks device/kernel/control-group mutation, gives the service a read-only OS and home tree, and permits writes only to `/var/lib/even-agent` and the dedicated Codex authentication directory. Do not enable `MemoryDenyWriteExecute`: Node/V8 uses executable JIT memory. Do not broaden `ReadWritePaths` to the source tree or web root.

Conversation JSON, SQLite state and generated Markdown are protected by filesystem permissions but are not application-level encrypted, and the application does not currently expire them automatically. Root compromise can therefore expose them. Do not put secrets in Lightsail launch/user data, keep only necessary personal data, and choose an explicit retention and encrypted-backup policy before treating the host as a long-term personal archive.

Before declaring the host ready, verify all of the following from the instance and from an external machine:

- `ufw status verbose` reports active/default-deny incoming, and the Lightsail console shows the same minimal IPv4 and IPv6 rules.
- `ss -lntup` shows Caddy on 80/443, SSH on 22, and Node only on `127.0.0.1:3001`; nothing listens publicly on SMTP, OAuth callback or database ports.
- Direct access to `http://PUBLIC_IP:3001` fails, while `https://calendar.eveng2assistant.com` has a valid certificate and HTTP redirects to HTTPS.
- An unauthenticated WSS connection and artifact download fail; an authenticated single-user client succeeds.
- `/etc/even-agent.env`, Google OAuth files, Calendar refresh token, SQLite data, conversations and artifacts are not group/world readable. Run `systemd-analyze security even-agent.service` and review any remaining exposure instead of treating its score as a proof of safety.

## CLI live test status

`tests/live-codex-smoke.ts` exercises classification and real native search without forwarding an API key. On 2026-09-16 the explicitly selected standalone Windows CLI 0.154.0 completed classification and an answer with four native search calls using the existing ChatGPT login. Restricted development execution could not access that login; normal user execution could. Set CODEX_CLI_PATH explicitly when multiple installations exist. Tests never read or copy auth credentials. Linux authentication, process-group cleanup and systemd restart behavior still need validation on the target Linux host; Windows success does not certify them.

Official Codex lifecycle/auth reference: https://learn.chatgpt.com/docs/non-interactive-mode
