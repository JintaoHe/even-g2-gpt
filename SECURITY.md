# Public source, private runtime

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/JintaoHe/even-g2-gpt/security/advisories/new). Do not disclose exploitable details or credentials in public issues. Only the current main branch is maintained; this experimental project does not provide a security response SLA.

## Publishing and deployment

Never commit `.env`, account auth, tokens, audio recordings/transcripts, user conversations, generated documents, SQLite databases, screenshots, logs, dependency directories or release output. `.env.example` contains empty credential fields only. Development/test fixtures must use synthetic or non-sensitive sample data.

Before publishing, stage only reviewed source/document paths, inspect `git diff --cached --stat` and run `npm run audit:public`. The audit scans staged blobs (including exact matches to long local .env secret values without printing them), rejects unexpected file types/paths, and checks common credential patterns. This supplements manual review; it cannot prove that all confidential data is absent. Ignore rules do not remove files already committed.

If a credential is ever published, revoke/rotate it immediately. Removing it in a later commit does not remove it from Git history or third-party copies. Do not paste secrets into public issues or logs.

This is an experimental single-user application, not a hardened public multi-tenant service. Keep the backend and development servers loopback-only until a separate TLS/auth/origin review. Never expose the simulator automation port. Keep API credentials and Codex auth only on the backend/service account. Artifacts and conversation backups are private; deploy only the server-only build described in docs/PROJECT_STRUCTURE.md.

The bootstrap `G2_CLIENT_TOKEN` is never written by the Even client. A successful bootstrap may issue a narrower device credential bound to one random client ID. The client stores it only through the native Even host-storage bridge, while SQLite stores a SHA-256 hash plus rotation metadata. The credential rotates on use, expires after 30 idle days, is revocable, and permits only creation of a new single-user conversation session—not provider access, arbitrary files, Calendar writes, or Email sends without their existing confirmations. A replacement is acknowledged only after native storage returns `true`; the previous generation remains valid for no more than five minutes and is then revoked.
