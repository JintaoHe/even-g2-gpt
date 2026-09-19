# Even G2 Agent

[简体中文](README.zh-CN.md) | **English**

A personal AI assistant for Even Realities G2: bilingual Chinese/English voice conversations, text on glasses, web search, Google Calendar management, and confirmation-gated Markdown email delivery.

**Independent community project. Not affiliated with, endorsed by, or published by Even Realities.** The packaged working name is **Glass Assistant** so the application itself does not present as an official Even product.

**Bring your own backend, for one trusted user.** OpenAI API is the default dialogue channel; Codex CLI is optional. Model keys, calendar authorization, and email credentials remain on your backend, never in the glasses client or public repository.

This is a development build. The browser conversation lab and Even SDK simulator are connected, and the single-user Linux backend has passed host-level deployment checks; **physical G2/R1 end-to-end testing and Even Hub publication are still pending**. This is not a published Even Hub app or a hosted multi-user service.

## Contents

- [Current capabilities](#current-capabilities)
- [Quick start](#quick-start)
- [Optional tools and configuration](#optional-tools-and-configuration)
- [Project structure and deployment](#project-structure-and-deployment)
- [Security and data boundaries](#security-and-data-boundaries)
- [Development and verification](#development-and-verification)
- [Limitations and next steps](#limitations-and-next-steps)
- [Documentation](#documentation)

## Current capabilities

| Area | Implemented scope |
| --- | --- |
| Conversation | Soniox `stt-rt-v5` mixed Chinese/English transcription at native 16 kHz, automatic utterance detection, contextual follow-ups, streamed text replies, interruption cancellation, and intent-based exit; scene-aware topic threads can pause and resume separate trip/business discussions within one session |
| Companion input | Optional phone text box for questions and exact strings such as email addresses, URLs, and IDs; the glasses themselves do not provide a keyboard |
| Location and ETA | Named/nearby route intent requests one short-lived phone fix (up to three attempts), supports far-city destinations, compares Places ratings with a Routes Matrix, and can use one quota-bound web lookup to resolve a temporary event venue before revalidating it in Places; coordinates never enter the LLM/history/logs. Local user/Linux/real-device acceptance is still pending |
| Audio buffering | 800ms pre-trigger buffer preserves captured speech onset without adding an 800ms wait; it cannot eliminate every transcription omission |
| Glasses reading | Live user transcription and final questions/answers; semantic, non-overlapping manual pages and session history; link syntax removed from the display while original sources remain available for export |
| Dialogue channels | OpenAI API by default; optional Codex CLI with waiting feedback, actual search events, timeout, and cancellation handling |
| Web search | API defaults: up to 10 calls per answer, 50 per 30-minute session, 100 per day, and 1200 per calendar month, with persistent accounting; CLI native search is separate from the API ledger |
| Reasoning | The default dual-Luna configuration selects one of nine cognitive modes plus independent workflows/task kinds, then bounds low / medium / high effort per turn; tools remain separately authorized |
| Calendar queries | Titles, times, locations, notes, and conflict checks; “next event” searches up to 93 days ahead and asks the user to resolve uncertain name matches |
| Calendar changes | Preview and confirmation before create/update/cancel; updates retain the original event, and creation sends a native Google invitation to the fixed recipient |
| Recurring events | Bounded daily/weekly series; requests without an end date default to three months, disclosed in notes; edits/cancellations distinguish one occurrence from the entire series |
| Documents and email | Requested plans, instructions, discussion points, or transcripts as topic-scoped MD (business and trip threads are not blended); save, preview, then confirm sending; descriptive subjects, summaries, attachment names, single-event ICS attachments, and controlled resend |
| Persistence | Conversations, jobs, files, and usage ledgers on your backend, with authenticated downloads, shutdown handling, and task recovery safeguards |

Google Calendar events and emailed ICS files are different capabilities: **a real event can be updated and notify attendees; a standalone ICS file is not a continuous synchronization service.** Recurring meetings use Google's native invitations; custom recurring ICS export is not supported yet.

## Quick start

### 1. Prepare the development environment

Requirements: **Node.js 24+**, npm, an OpenAI API key for API dialogue, and a Soniox API key for the default speech transcription path.

```sh
git clone https://github.com/JintaoHe/even-g2-gpt.git
cd even-g2-gpt
npm ci
```

Copy [.env.example](.env.example) to `.env` **only if `.env` does not already exist**. Never overwrite existing credentials. Configure these first:

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Backend only; never enter it in the browser or glasses client |
| `SONIOX_API_KEY` | Backend-only real-time STT credential; never ship it in the Even client or Hub package |
| `STT_PROVIDER=soniox` | Default native-16-kHz bilingual transcription; `openai` is retained as an explicit rollback |
| `G2_CLIENT_TOKEN` | Your own random access password, at least 32 characters; not an official Even token, and no glasses are required to create it |
| `DIALOGUE_PROVIDER=api` | Default API dialogue; CLI mode requires a separate CLI login |

Keep the sample model and port settings initially. Email and Google Calendar are disabled by default; enable them after basic conversation works.

### 2. Start the browser conversation lab

```sh
npm run conversation
```

Open <http://127.0.0.1:3001> and connect with **G2_CLIENT_TOKEN**. Test text first, then explicitly enable the microphone. The page shows the active API/CLI channel. For Windows startup troubleshooting, see the [conversation guide, in Chinese](docs/CONVERSATION_LAB.md#启动).

`npm start` runs the earlier single-turn transcription POC, not the continuous conversation server.

### 3. Connect the SDK client and simulator

Keep the backend running. Use two additional terminals, each starting from the repository root:

```sh
# Terminal A: SDK frontend
cd clients/even
npm ci
npm run dev
```

```sh
# Terminal B: simulator
cd tools/even-simulator
npm ci
npm start
```

Enter the application token in the simulator's companion page. The backend allows one active authenticated owner; disconnect the browser lab before switching to the simulator. See [SDK controls and pagination](clients/even/README.md) and [simulator startup and exit troubleshooting](tools/even-simulator/README.md).

## Optional tools and configuration

### Google Calendar

Use a dedicated assistant Google account and a separate calendar, named `Even Assistant` by default. Complete OAuth, then explicitly enable `GOOGLE_CALENDAR_ENABLED`. Do not substitute your primary personal account for the dedicated account.

- Relative Calendar times use the current one-shot location's IANA timezone (for example Los Angeles or New York), while an explicitly named event timezone wins. Google Time Zone is primary; if it remains unavailable, Luna receives bounded session context and a validated device-zone hint—but no coordinates—and either resolves a strict IANA zone or asks one city/region question. It never silently assumes Chicago, and the fallback cannot bypass write confirmation.
- Draft content is separate from one-use authorization. A misheard confirmation is not permission to submit; create/update/cancel still require confirmation.
- Queries cover only the bound calendar. External, non-assistant-created, or unsupported events may be read-only.
- The three-month recurrence default does not auto-renew. Entire-series operations include past occurrences.

See the [Google Calendar guide, mixed Chinese/English](docs/google-calendar.md) for setup, 403 troubleshooting, credential recovery, and recurrence boundaries.

### Current-location ETA

The optional route path obtains an automatic phone fix and keeps a session-only
location context refreshed at most every 10 seconds, then uses Places Text
Search (New), and one Routes Compute Route Matrix request for up to three nearby
candidates. Driving is the default; spoken or companion controls can switch to
walking/cycling. Results combine compact ETA/distance, traffic when applicable,
rating confidence and a recommendation. A recent-mode follow-up uses the newest
fresh-enough session fix and reuses bounded Place IDs. Coordinates stay only in
live memory and are cleared on explicit stop, disconnect, or session exit. It is disabled until a separate, server-only Google
Maps key is enabled and restricted to those two APIs and the
calling machine/server IP. The Calendar OAuth secret is not a Maps key. See
[Google Maps route setup](docs/setup/GOOGLE_MAPS_ROUTES.md) before local testing.

### Markdown, email, and attachments

API conversations can generate requested standalone documents, not just transcripts. Files live in your own backend data directory; **they do not automatically appear in the ChatGPT website or a public artifact store**.

Email uses a dedicated Gmail sender and one fixed recipient. Explicitly enable `EVEN_EMAIL_ENABLED`. The assistant previews the saved document before asking for send confirmation. SMTP acceptance does not prove inbox delivery. Recovery offers mailbox checks, one separately confirmed resend, and authenticated downloads.

See [email setup and delivery safeguards](docs/EMAIL_DELIVERY.md) and [calendar attachment design](docs/CALENDAR_EMAIL_DESIGN.md).

### API and Codex CLI

API is the default dialogue experience. CLI requires the operator's own login and uses that account's allowance. **Dialogue channel selection is independent of STT**: speech uses Soniox by default and still incurs provider usage. CLI does not guarantee equivalent speed, streaming, or tool support. API conversational document generation should not be assumed available in CLI mode.

See [channel selection and authentication](docs/CODEX_CLI_CHANNEL.md) and [application-level reasoning selection](docs/ADAPTIVE_REASONING.md). Search-call limits are not a total dollar spending cap: dialogue, transcription, and document generation incur separate usage.

For this personal deployment, configure an OpenAI **project** monthly spend limit
of `$40` and turn on hard-limit enforcement in the API dashboard. The in-app search
ledger is defense in depth, not a replacement for the provider-side cap; Google
Maps and AWS have separate billing controls.

## Project structure and deployment

```text
src/                   Backend and historical POC entry points
web/                   Local browser conversation lab
clients/even/          Independently built Even SDK frontend
tools/even-simulator/  Simulator and development tools
tests/                 Automated tests and opt-in live checks
scripts/               Build, authorization, audit, and smoke-test tools
deploy/                Linux systemd template
docs/                  Setup, operations, design, and acceptance guides
.local/                Private runtime data (not committed)
```

`npm run build:server` creates a separate `dist/server-*` backend release directory. **Deploy only a successful build and inspect its `BUILD-MANIFEST.json`; do not upload the entire development checkout.**

The server release excludes the browser lab, SDK frontend, simulator, tests, credentials, and local data. Build the SDK separately; configure Linux credentials and data separately. Node stays on loopback behind the deployed HTTPS/WSS reverse proxy; port 3001 is not public. The Even Hub client now has a separate production bundle and exact network whitelist, but Private Testing and physical-device acceptance are still pending.

See [deployment boundaries](docs/PROJECT_STRUCTURE.md), [Linux lifecycle, storage, and migration](docs/LINUX_OPERATIONS.md), and [automatic Linux updates with rollback](docs/setup/AUTOMATIC_UPDATES.md).

## Security and data boundaries

- Commit only source, synthetic tests, and documentation—not `.env`, OAuth JSON, CLI auth, recordings, private conversations, generated files, or runtime databases.
- Operators manage `.local` data. Git ignore is not encryption; configure access controls, backups, and retention.
- The backend constrains calendar and mail operations. The model cannot choose arbitrary recipients, read server files, or directly execute a shell.
- Uncertain writes are not automatically replayed, avoiding duplicate events or mail. Bounded read retries are different from write retries.
- Keep simulator automation ports local; never expose them publicly.
- Models and search services process relevant content. Local storage or `store:false` does not guarantee zero retention by providers.

Follow the [security policy](SECURITY.md) to report vulnerabilities. Never post credentials or private logs in public issues.

## Development and verification

Offline checks from the repository root:

```sh
npm run typecheck
npm test
npm run build:server
node scripts/audit-public.mjs --worktree
```

Separate SDK checks:

```sh
cd clients/even
npm test
npm run build
```

Before publishing, also scan staged content (`npm run audit:public`) and historical files (`node scripts/audit-public.mjs --history`). Scanning does not replace manual review and does not inspect Git author identities. Real-model evaluations consume allowance; live mail/calendar scripts can cause external side effects. **Review and authorize them separately as documented; they are not part of default CI.**

See [contribution guidelines](CONTRIBUTING.md) and [release readiness](docs/RELEASE_READINESS.md).

## Limitations and next steps

- Simulator success does not certify hardware BLE, fonts, battery, permissions, phone lock-screen behavior, or background lifecycle. Always-on wake words and background operation are not promised.
- Recurrence does not yet support monthly rules, multiple weekdays, all-day series, or “this and following” splits. Real recurring-invitation delivery and synchronization need dedicated acceptance testing.
- Audio detection is an energy-based baseline. Noise, quiet speech, transcription, and intent recognition can still fail; 800ms buffering preserves only audio already captured.
- There is no multi-tenant isolation. Reconnecting does not automatically restore full conversation context.
- Next priorities: user local route acceptance → Linux route deployment/live test → post-deployment security review → final Even Hub package/Private Testing → physical G2/R1 acceptance → Beta lock/background testing.

## Documentation

Browse the **[documentation index](docs/README.md)**. The README and index are available in both languages; linked detailed guides retain their existing language and are not all translated.

| Goal | Start here |
| --- | --- |
| Test voice and browser conversations | [Conversation lab (Chinese)](docs/CONVERSATION_LAB.md) |
| Test glasses display and controls | [SDK client](clients/even/README.md) · [Simulator](tools/even-simulator/README.md) |
| Configure calendars, invitations, and recurring events | [Google Calendar (mixed Chinese/English)](docs/google-calendar.md) |
| Generate MD and send email | [Document and email delivery](docs/EMAIL_DELIVERY.md) |
| Deploy your Linux backend | [Deployment boundaries](docs/PROJECT_STRUCTURE.md) · [Linux operations](docs/LINUX_OPERATIONS.md) |
| Understand the roadmap and remaining work | [Release readiness](docs/RELEASE_READINESS.md) · [Development plan](docs/DEVELOPMENT_PLAN.md) |
