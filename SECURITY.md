# Public source, private runtime

Never commit `.env`, account auth, tokens, audio recordings/transcripts, user conversations, generated documents, SQLite databases, screenshots, logs, dependency directories or release output. `.env.example` contains empty credential fields only. Development/test fixtures must use synthetic or non-sensitive sample data.

Before publishing, stage only reviewed source/document paths, inspect `git diff --cached --stat` and run `npm run audit:public`. The audit scans staged blobs (including exact matches to long local .env secret values without printing them), rejects unexpected file types/paths, and checks common credential patterns. This supplements manual review; it cannot prove that all confidential data is absent. Ignore rules do not remove files already committed.

If a credential is ever published, revoke/rotate it immediately. Removing it in a later commit does not remove it from Git history or third-party copies. Do not paste secrets into public issues or logs.

This is an experimental single-user application, not a hardened public multi-tenant service. Keep the backend and development servers loopback-only until a separate TLS/auth/origin review. Never expose the simulator automation port. Keep API credentials and Codex auth only on the backend/service account. Artifacts and conversation backups are private; deploy only the server-only build described in docs/PROJECT_STRUCTURE.md.
