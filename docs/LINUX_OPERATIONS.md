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
4. Review/install the systemd unit, reload the manager and start the service. Current listener deliberately accepts only loopback hostnames. For initial remote testing use an SSH localhost tunnel. Public TLS/reverse-proxy host support is not implemented here.
5. Confirm text conversation, job export/download, disconnect/reconnect, SIGTERM shutdown, forced service restart, login persistence and absence of leftover CLI children on Linux. No actual Linux host was provided in this workspace.
6. Back up while stopped, or use a SQLite-aware consistent backup; do not blindly copy only the main SQLite file while WAL is active. Protect snapshots, transcripts and documents as private data. Container installations must mount persistent data/auth volumes and forward termination signals.

## CLI live test status

`tests/live-codex-smoke.ts` exercises classification and real native search without forwarding an API key. On 2026-09-16 the explicitly selected standalone Windows CLI 0.154.0 completed classification and an answer with four native search calls using the existing ChatGPT login. Restricted development execution could not access that login; normal user execution could. Set CODEX_CLI_PATH explicitly when multiple installations exist. Tests never read or copy auth credentials. Linux authentication, process-group cleanup and systemd restart behavior still need validation on the target Linux host; Windows success does not certify them.

Official Codex lifecycle/auth reference: https://learn.chatgpt.com/docs/non-interactive-mode
