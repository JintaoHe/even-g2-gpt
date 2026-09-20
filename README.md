# Glass Assistant for Even G2

[简体中文](README.zh-CN.md) | **English**

A self-hosted, single-user personal AI assistant for Even Realities G2. It can hold bilingual voice conversations, remember the current session, reason across different topics, research the web, compare routes and places, manage a dedicated Google Calendar, and deliver Markdown documents by email.

> **Independent community project.** This project is not affiliated with, endorsed by, or published by Even Realities. **Glass Assistant** is a working name chosen to avoid presenting the app as an official Even product.

[![CI](https://github.com/JintaoHe/even-g2-gpt/actions/workflows/ci.yml/badge.svg)](https://github.com/JintaoHe/even-g2-gpt/actions/workflows/ci.yml)

## Project status

The current source has passed local browser and Even SDK simulator acceptance for bilingual speech, contextual conversation, web research, routes, Calendar create/update/cancel flows, email delivery, interruption, pagination, and exit/reconnect behavior. The single-user Linux deployment path, HTTPS/WSS reverse proxy, monitoring, backups, and rollback workflow are also implemented.

The latest source still needs a fresh Linux deployment and live acceptance before packaging the next Even Hub build. **Physical G2/R1 testing and Even Hub publication remain pending.** This repository is not a hosted multi-user service.

## What the assistant is designed to feel like

Glass Assistant is intended to behave like a personal assistant, not a data-reporting bot:

- **Talk naturally:** Soniox `stt-rt-v5` handles native 16 kHz Mandarin/English code-switching, with an 800 ms pre-trigger buffer and interruption support.
- **Remember the current conversation:** durable session messages plus a bounded summary/recent-message context resolve references such as “the second point,” “that idea,” or “the place you recommended.” A disconnected client can resume the same logical session within 15 minutes without mixing topic-scoped exports.
- **Adapt every turn:** one of nine cognitive modes is selected for the current goal—`casual`, `explain`, `research`, `brainstorm`, `decision_support`, `planning`, `deep_reasoning`, `compose`, or `coaching`. Tool workflows are authorized separately.
- **Be useful and warm:** the assistant can execute tasks, think with the user, or simply respond socially. Praise, frustration, and conversational closure should receive a human-friendly response rather than another intake form.
- **Ask one thing at a time:** when information is genuinely missing, it asks for one atomic fact or decision per turn instead of presenting a long questionnaire on the glasses.
- **Show readable glasses pages:** live/final user speech and assistant answers use semantic, non-overlapping manual pages. URLs and internal metadata are removed from the glasses body while sources remain available for exported material.

## Current capabilities

| Capability | Current behavior |
| --- | --- |
| Voice conversation | Soniox real-time bilingual STT, automatic utterance completion, streamed answers, interruption cancellation, session exit intent, and OpenAI STT as an explicit rollback |
| Session intelligence | SQLite-backed logical sessions, rotating resume credentials, bounded summaries/recent messages, and isolated topic threads; modes and workflows are re-evaluated every turn |
| Web research | OpenAI API search with persistent per-answer/session/day/month quotas; actual search progress is shown instead of leaving the user waiting silently |
| Places and routes | Session-only phone location, Places candidates and ratings, traffic-aware Routes Matrix comparisons, drive/walk/bicycle modes, ambiguity clarification, and a bounded public-research fallback for venue context |
| Outdoor evidence | Weather, air quality, and pollen can be fetched concurrently for relevant time-bounded outdoor plans; unavailable evidence remains unknown instead of being treated as safe |
| Google Calendar | Query titles, times, locations, notes and conflicts; create/update/cancel single or bounded recurring events; plan up to six itinerary events and confirm them one at a time |
| Dynamic time zones | Google Time Zone is primary. A bounded Luna fallback receives no coordinates and must return a valid IANA zone or ask one location question |
| Documents and email | Generate a topic-scoped Markdown artifact, preview it, request confirmation, and send it to the configured fixed recipient with a descriptive subject and attachment name |
| Optional CLI channel | Codex CLI remains available for operators who prefer subscription-backed execution, with timeout/cancellation feedback; the API channel is the default low-latency experience |
| Persistence | Backend-owned conversations, jobs, documents and usage ledgers; credentials and exact coordinates are excluded from those records |

Calendar and email are authoritative private-state workflows. They never fall back to a model guess: writes require backend validation, preview-bound confirmation, idempotency handling, and a receipt. Maps, Weather, Air Quality, and Pollen are read-only evidence and may use a clearly disclosed, quota-bounded public-research fallback.

## Architecture

```text
Even G2 / R1 or local simulator
              |
              | authenticated WSS
              v
      self-hosted Node backend
       |        |         |
     Soniox   OpenAI   validated tools
       STT     Luna     Calendar / Email
                         Maps / Environment
```

- The Even client contains no model, SMTP, Calendar, or Maps credentials.
- Node listens on loopback in production and is exposed only through HTTPS/WSS.
- The public Hub package must be rebuilt by each operator with their own backend URL and exact network whitelist.
- This is currently a **single trusted user** design; there is no multi-tenant account isolation.

See [project structure and deployment boundaries](docs/PROJECT_STRUCTURE.md) and [cognitive/workflow routing](docs/COGNITIVE_WORKFLOW_ROUTING.md).

## Quick start

### 1. Install

Requirements: **Node.js 24+**, npm, an OpenAI API key for dialogue, and a Soniox API key for the default speech path.

```sh
git clone https://github.com/JintaoHe/even-g2-gpt.git
cd even-g2-gpt
npm ci
```

Copy [.env.example](.env.example) to `.env` only when `.env` does not already exist. Never commit `.env` or copy real credentials into an issue, log, simulator bundle, or Hub package.

Minimum configuration:

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Backend-only dialogue and approved web-search access |
| `SONIOX_API_KEY` | Backend-only real-time transcription credential |
| `STT_PROVIDER=soniox` | Default bilingual STT; use `openai` only for rollback/testing |
| `G2_CLIENT_TOKEN` | Your own random backend access secret, at least 32 characters; not an official Even token |
| `DIALOGUE_PROVIDER=api` | Default low-latency dialogue path; `cli` is optional |

Calendar, email, Maps, Time Zone, Weather, Air Quality, and Pollen stay disabled until their dedicated server-side credentials and restrictions are configured.

### 2. Run the browser conversation lab

```sh
npm run conversation
```

Open <http://127.0.0.1:3001>, enter `G2_CLIENT_TOKEN`, test text first, and then explicitly enable the microphone. See the [conversation lab guide](docs/CONVERSATION_LAB.md).

`npm start` is the earlier single-turn transcription POC; it is not the continuous assistant server.

### 3. Run the Even client and simulator

Keep the backend running and use two additional terminals from the repository root:

```sh
# Terminal A: Even SDK frontend
cd clients/even
npm ci
npm run dev
```

```sh
# Terminal B: local simulator
cd tools/even-simulator
npm ci
npm start
```

Enter the application token on the companion page. Only one authenticated owner connection is allowed, so disconnect the browser lab before switching to the simulator. See [Even client controls](clients/even/README.md) and [simulator troubleshooting](tools/even-simulator/README.md).

## Optional services

| Service | What it enables | Setup |
| --- | --- | --- |
| Google Calendar | Queries, conflict checks, invitations, recurring events, and confirmed updates/cancellations | [Calendar guide](docs/google-calendar.md) |
| Gmail SMTP | Confirmed delivery of Markdown and ICS attachments to one fixed recipient | [Email delivery](docs/EMAIL_DELIVERY.md) |
| Google Places and Routes | Nearby/far destination resolution, ETA, distance, traffic and ratings | [Maps and Routes](docs/setup/GOOGLE_MAPS_ROUTES.md) |
| Time Zone API | Location-aware IANA time zones for relative Calendar requests | [Google API production](docs/setup/GOOGLE_API_PRODUCTION.md) |
| Weather, Air Quality, Pollen | Structured evidence for outdoor planning | [Maps and environment setup](docs/setup/GOOGLE_MAPS_ROUTES.md) |
| Codex CLI | Optional alternative dialogue execution with lifecycle and timeout controls | [CLI channel](docs/CODEX_CLI_CHANNEL.md) |

For this personal deployment, the application now enforces a persistent `$80` monthly provider ledger: OpenAI `$50`, Soniox `$20`, and Google `$10`. Lightsail and other infrastructure remain separate. Application controls are defense in depth, not a substitute for provider-side billing limits. See [Monthly provider cost controls](docs/COST_CONTROLS.md).

## Security and privacy boundaries

- Commit source, synthetic fixtures, and documentation only—not `.env`, OAuth JSON, CLI authentication, recordings, private conversations, generated documents, or runtime databases.
- Exact GPS coordinates live only in volatile session adapters. They refresh at most every 10 seconds, become unusable after two minutes, never enter Luna/search/history/logs/artifacts, and are cleared on stop, disconnect, or session exit.
- Calendar and email credentials stay in the backend. The model cannot select arbitrary recipients, read arbitrary server files, or directly execute a shell.
- A cognitive mode, previous confirmation, or model statement never grants write permission. Every side effect is revalidated against its current preview.
- Unknown Calendar/email write results are checked rather than automatically replayed, preventing duplicate events or messages.
- `.gitignore` is not encryption. Operators remain responsible for backend access controls, retention, encrypted backups, provider policies, and credential rotation.

Read [SECURITY.md](SECURITY.md) before exposing a backend to the internet. Never post credentials or private logs in a public issue.

## Project layout and deployment

```text
src/                   Backend and historical POC entry points
web/                   Local browser conversation lab
clients/even/          Independently built Even SDK frontend
tools/even-simulator/  Simulator and development tools
tests/                 Automated tests and opt-in paid/live checks
scripts/               Build, audit, authorization, and smoke-test tools
deploy/                Linux systemd, monitoring, backup, and update templates
docs/                  Setup, product, security, and acceptance references
.local/                Private runtime data (ignored; never deploy from Git)
```

`npm run build:server` creates a separate `dist/server-*` backend release. Deploy that verified server artifact—not the entire development checkout. The release excludes the browser lab, SDK source, simulator, tests, credentials, and local runtime data.

Start with [Linux deployment](docs/setup/LINUX_DEPLOYMENT.md), [operations](docs/LINUX_OPERATIONS.md), [automatic updates and rollback](docs/setup/AUTOMATIC_UPDATES.md), and [monitoring/backup recovery](docs/setup/MONITORING_BACKUP_RECOVERY.md).

## Verification

Run from the repository root:

```sh
npm run typecheck
npm test
npm run build:server
node scripts/audit-public.mjs --worktree
node scripts/audit-public.mjs --history
```

Then verify the Even client separately:

```sh
cd clients/even
npm test
npm run build
```

Live Calendar, email, Maps, environment, STT, and real-model scripts may consume quota or create external side effects. They are intentionally excluded from default CI and must be reviewed and authorized individually.

## Known limits and next steps

- Simulator success does not certify BLE behavior, phone permissions, battery, thermals, lock-screen/background lifecycle, fonts, or R1 gestures on physical hardware.
- There is no always-on wake word or guaranteed all-day background assistant mode.
- A disconnected client can resume the same logical session for 15 minutes. This is durable session memory, not cross-session personal/profile memory; an ended or expired session is not silently reopened.
- Recurrence currently covers bounded daily/weekly series, not monthly rules, multiple weekdays, all-day series, or “this and following” splits.
- Transit routing and direct handoff into Apple Maps/Google Maps are not implemented.

Next sequence: deploy the current `main` server build to Linux → run live route/environment/Calendar/email acceptance and a post-deployment security review → create one fresh Even Hub package → complete physical G2/R1 and background-lifecycle testing.

## Documentation

Browse the bilingual **[documentation index](docs/README.md)**.

| Goal | Start here |
| --- | --- |
| Understand assistant modes, topic memory, tools, and companion tone | [Cognitive/workflow routing](docs/COGNITIVE_WORKFLOW_ROUTING.md) · [Adaptive reasoning](docs/ADAPTIVE_REASONING.md) |
| Test voice conversation and the browser lab | [Conversation lab](docs/CONVERSATION_LAB.md) |
| Test glasses display, controls, location, and the simulator | [Even client](clients/even/README.md) · [Simulator](tools/even-simulator/README.md) |
| Configure Calendar, invitations, and recurrence | [Google Calendar](docs/google-calendar.md) |
| Generate Markdown and deliver email | [Email delivery](docs/EMAIL_DELIVERY.md) |
| Deploy and operate the private Linux backend | [Linux deployment](docs/setup/LINUX_DEPLOYMENT.md) · [Linux operations](docs/LINUX_OPERATIONS.md) |
| Review release gates and remaining work | [Release readiness](docs/RELEASE_READINESS.md) · [Development plan](docs/DEVELOPMENT_PLAN.md) |
