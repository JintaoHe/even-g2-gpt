# Simulator tooling only

`npm ci`, then `npm start` after the backend and SDK Vite server are running.

Pinned official simulator 0.9.3, SDK 0.0.14 in the separate client package. This directory is never part of the Linux backend artifact. Screenshots are local debug output and ignored by git. Stop this process when no longer testing; its local automation API on 9898 is unauthenticated and must never be port-forwarded or exposed publicly.

The simulator opens two native windows: Browser (companion controls) and Glasses Display (SDK framebuffer). UI token entry and microphone permissions are manual. Use the dev-only local layout sample before connecting to test pagination without model requests. Root double-click must show the system exit dialog. Restart the simulator after SDK hot-reload initialization errors; do not silently bypass SDK page lifecycle errors.

Backend production: only root `npm run build:server` output. SDK production: `npm run build` inside clients/even. Neither release includes this simulator.

Known scope: the simulator cannot certify BLE latency, hardware fonts, permissions, phone background behavior or battery consumption. Real G2/R1 validation remains required.

Official simulator/automation reference: https://hub.evenrealities.com/docs/test/simulator

## Validation 2026-09-16 (Windows)

- SDK clean startup and actual glasses display verified visually.
- Bilingual seven-page fixture rendered; native Down changed page 1 to page 2.
- Authenticated development proxy → real API backend returned nine streaming chunks (transport test, not full microphone-to-display acceptance).
- Client typecheck/build and two pager tests pass; 43 backend tests pass. Client production bundle excludes the dev fixture; backend whitelist build excludes all client/simulator code.
- **Open issue:** root double-click followed by `shutDownPageContainer(1)` produced a blank glasses display rather than a visible system confirmation in this simulator install. Mode 1 is retained; no silent mode-0 workaround. Display writes are suspended during exit. Confirmation/cancellation needs further simulator/real-device investigation.
- SDK audio wiring exists but real microphone capture/STT and voice-triggered exit have not been end-to-end validated. No microphone permission was granted or recording started by the implementation test.

### Isolated exit diagnosis (reading v2)

Launch a separate simulator against `http://127.0.0.1:5173/dev/exit-probe.html --automation-port 9899`. This page does not import our dialogue/view state, open a WebSocket, capture audio, or update the display on a timer. On the installed Windows simulator 0.9.3 / SDK 0.0.14:

- startup result 0; framebuffer had 1,523 pixels with alpha > 0;
- double-click delivered event 3; probe requested exitMode=1;
- SDK returned true; framebuffer then had 0 lit pixels, with no visible confirmation.

The failure therefore reproduces outside our application logic. This narrows it to the simulator/SDK host exit path; it does not prove which component is defective or predict real-device behavior. Keep mode 1 and mark confirmation/cancellation unverified until hardware or a validated simulator fix is available. The isolated probe was stopped after measurement; it did not use account credentials or model allowance.
