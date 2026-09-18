# Documentation index

[简体中文](README.zh-CN.md) | **English**

[Back to the project overview](../README.md)

Start with the operational and configuration guides. Design plans and evaluation reports include historical information, not a promise that every planned feature is implemented. For current scope, use the project overview, the relevant feature guide, and the release-readiness checklist.

The overview and this index are bilingual. Detailed guides below retain their existing language; some are Chinese or mixed Chinese/English rather than full English translations.

## Running the app and clients

- [Conversation lab (Chinese)](CONVERSATION_LAB.md): browser startup, audio capture, follow-ups, search, and limitations.
- [Even SDK client](../clients/even/README.md): connection, pagination, transcription display, history, and exit recovery.
- [Even Hub packaging and Private Testing (Chinese)](EVEN_HUB_PACKAGING.md): release identity, permissions, `.ehpk`, portal upload, and physical-device acceptance.
- [Official simulator](../tools/even-simulator/README.md): startup, separate dependencies, and known platform issues.
- [Earlier single-turn POC](POC.md): audio injection and the initial transcription pipeline, not the current continuous-dialogue entry point.

## Feature configuration

- [Google Calendar (mixed Chinese/English)](google-calendar.md): OAuth, dedicated calendars, troubleshooting, credential recovery, confirmed writes, conflicts, and recurring meetings.
- [Markdown and email](EMAIL_DELIVERY.md): dedicated Gmail, fixed recipient, generation/send confirmation, resend, and downloads.
- [Calendar attachment design](CALENDAR_EMAIL_DESIGN.md): MD/ICS delivery and timezones; use the Calendar guide for real Google events.
- [API / Codex CLI](CODEX_CLI_CHANNEL.md): channel selection, native search, authentication, and capability differences.
- [Adaptive reasoning](ADAPTIVE_REASONING.md): application-level none / low / medium selection and safeguards.

## Deployment, security, and contributions

- [Deployment and account setup hub (Chinese)](setup/README.md): step-by-step Linux, Google OAuth production, and Tailscale guides for first-time operators.
- [Production monitoring, logs, and recovery (Chinese)](setup/MONITORING_BACKUP_RECOVERY.md): health probes, bounded journald retention, verified daily backups, and recovery drills.
- [WinSCP to Lightsail (Chinese)](setup/WINSCP_LIGHTSAIL.md): step-by-step private SFTP login over Tailscale, key conversion, host-key verification, and safe uploads.
- [Project and deployment boundaries](PROJECT_STRUCTURE.md): allowlisted server builds and client/simulator separation.
- [Linux operations](LINUX_OPERATIONS.md): processes, systemd, task storage, backups, and migration.
- [Release readiness](RELEASE_READINESS.md): verified scope and physical-device/Linux/Even Hub acceptance gates.
- [Configuration example](../.env.example): empty credentials and defaults; never commit real configuration.
- [Security policy](../SECURITY.md) · [Contribution guidelines](../CONTRIBUTING.md).

## Design and historical evaluations

These documents explain design evolution. They are not guarantees of current pricing, latency, or service availability.

- [Development plan](DEVELOPMENT_PLAN.md): implementation baseline and longer-term direction.
- [Conversation MVP](CONVERSATION_MVP.md): initial scope and interaction goals.
- [STT evaluation plan](STT_BAKEOFF.md): historical options; the project now uses OpenAI, and the Soniox comparison was cancelled.
- [GPT-5 Nano evaluation](GPT5_NANO_EVAL.md) · [Luna evaluation](LUNA_EVAL.md).
- [Dynamic reasoning evaluation](DYNAMIC_REASONING_EVAL.md): small-sample results; see the adaptive-reasoning guide for implementation details.

Real-model, SMTP, and Calendar smoke tests may incur charges, send mail, or change events. Read the relevant guide first; do not batch-run all scripts.
