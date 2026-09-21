# Documentation index

[简体中文](README.zh-CN.md) | **English**

[Back to the project overview](../README.md)

Start with the operational and configuration guides. Design plans and evaluation reports include historical information, not a promise that every planned feature is implemented. For current scope, use the project overview, the relevant feature guide, and the release-readiness checklist.

The overview and this index are bilingual. Detailed guides below retain their existing language; some are Chinese or mixed Chinese/English rather than full English translations.

## Running the app and clients

- [One-click simulator restart](validation/RESTART_SIMULATOR.md): Windows launcher with explicit Local / Linux backend selection.

- [Conversation lab (Chinese)](CONVERSATION_LAB.md): browser startup, audio capture, follow-ups, search, and limitations.
- [Session resilience implementation (Chinese)](SESSION_RESILIENCE_IMPLEMENTATION_PLAN.md): SQLite ownership, resume credentials, client/audio lifecycle, bounded summaries, and phased verification.
- [Even SDK client](../clients/even/README.md): connection, pagination, transcription display, history, and exit recovery.
- [Even Hub packaging and Private Testing (Chinese)](EVEN_HUB_PACKAGING.md): release identity, permissions, `.ehpk`, portal upload, and physical-device acceptance.
- [Companion input, location, and safe distribution](COMPANION_INPUT_LOCATION_AND_DISTRIBUTION.md): phone typing, GPS/route privacy, naming, and why a personal build cannot be a public shared-server binary.
- [Official simulator](../tools/even-simulator/README.md): startup, separate dependencies, and known platform issues.
- [Earlier single-turn POC](POC.md): audio injection and the initial transcription pipeline, not the current continuous-dialogue entry point.

## Feature configuration

- [Google Calendar (mixed Chinese/English)](google-calendar.md): OAuth, dedicated calendars, troubleshooting, credential recovery, confirmed writes, conflicts, and recurring meetings.
- [Google Maps route setup](setup/GOOGLE_MAPS_ROUTES.md): volatile session phone location, 10-second SDK refresh, Places/Routes key restrictions, local/Linux gates, fallbacks, and coordinate privacy.
- [Monthly provider cost controls](COST_CONTROLS.md): the $80 OpenAI/Soniox/Google ledger, Google free-SKU thresholds, fixed-recipient alerts, reset boundaries, and accuracy limits.
- [Markdown and email](EMAIL_DELIVERY.md): dedicated Gmail, fixed recipient, generation/send confirmation, resend, and downloads.
- [Calendar attachment design](CALENDAR_EMAIL_DESIGN.md): MD/ICS delivery and timezones; use the Calendar guide for real Google events.
- [API / Codex CLI](CODEX_CLI_CHANNEL.md): channel selection, native search, authentication, and capability differences.
- [Cognitive mode, workflow, task kind, and tools](COGNITIVE_WORKFLOW_ROUTING.md): the current four-axis routing contract, allowlists, compatibility, and security boundaries.
- [Scene-aware reasoning and topic threads](ADAPTIVE_REASONING.md): low / medium / high effort and isolated topic switching/resumption.
- [Retired Conditional Task Orchestrator](CONDITIONAL_TASK_ORCHESTRATOR.md): historical design and tests; runtime planning now belongs to Luna with cautious read-tool fallbacks.
- [Intent reasoning A/B](INTENT_REASONING_AB.md): low-versus-medium routing accuracy and latency measurement.

## Deployment, security, and contributions

- [Deployment and account setup hub (Chinese)](setup/README.md): step-by-step Linux, Google OAuth production, Google Maps routes, and Tailscale guides for first-time operators.
- [Production monitoring, logs, and recovery (Chinese)](setup/MONITORING_BACKUP_RECOVERY.md): health probes, bounded journald retention, verified daily backups, and recovery drills.
- [Session migration and retention (Chinese)](setup/SESSION_MIGRATION_RETENTION.md): safe legacy JSON import, three-year cleanup policy, storage warnings, and restore verification.
- [WinSCP to Lightsail (Chinese)](setup/WINSCP_LIGHTSAIL.md): step-by-step private SFTP login over Tailscale, key conversion, host-key verification, and safe uploads.
- [Project and deployment boundaries](PROJECT_STRUCTURE.md): allowlisted server builds and client/simulator separation.
- [Linux operations](LINUX_OPERATIONS.md): processes, systemd, task storage, backups, and migration.
- [Release readiness](RELEASE_READINESS.md): verified scope and physical-device/Linux/Even Hub acceptance gates.
- [Configuration example](../.env.example): empty credentials and defaults; never commit real configuration.
- [Security policy](../SECURITY.md) · [Contribution guidelines](../CONTRIBUTING.md).

## Design and historical evaluations

- [Personal Intelligence — next-stage specification (Chinese)](PERSONAL_INTELLIGENCE_SPEC.md): accepted design direction, not yet implemented; five gated PRs for recommendations, continuity and guest isolation, recall, explicit memory, and opt-in nudges.

These documents explain design evolution. They are not guarantees of current pricing, latency, or service availability.

- [Development plan](DEVELOPMENT_PLAN.md): implementation baseline and longer-term direction.
- [Conversation MVP](CONVERSATION_MVP.md): initial scope and interaction goals.
- [STT evaluation plan](STT_BAKEOFF.md): provider architecture and regression method; Soniox is now the default, with OpenAI retained as rollback.
- [GPT-5 Nano evaluation](GPT5_NANO_EVAL.md) · [Luna evaluation](LUNA_EVAL.md).
- [Dynamic reasoning evaluation](DYNAMIC_REASONING_EVAL.md): small-sample results; see the adaptive-reasoning guide for implementation details.

Real-model, SMTP, and Calendar smoke tests may incur charges, send mail, or change events. Read the relevant guide first; do not batch-run all scripts.
