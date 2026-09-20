# Glass Assistant client

Independent package, lockfile, TypeScript and Vite build. No API key belongs here.

1. Start the existing root backend: `npm run conversation` (port 3001, API default).
2. Here: `npm ci`, then `npm run dev` (127.0.0.1:5173 only).
3. Start the simulator from `tools/even-simulator` (see its README).
4. In the simulator's **Browser** companion window enter the local G2_CLIENT_TOKEN and connect. Disconnect any old browser conversation first; the backend permits one active owner. The **Glasses Display** window is the actual SDK output, not the HTML preview.
5. Send text. Answers use stable, non-overlapping pages. Numbered or bulleted points become semantic pages where possible; a point longer than five body lines continues on the next page without repeating old lines. Use Up/Down on G2 or R1 to move one page at a time, or use the mouse wheel over the simulator preview. Explicitly enable the mic to test continuous voice; entering the app does not start recording. Click toggles capture; Double Click stops capture and requests the native system exit dialog. If cancelled, use the companion resume control; capture never restarts automatically.

The channel label comes from the authenticated backend. API keys stay there; audio is still API STT. The bootstrap `G2_CLIENT_TOKEN` stays in WebView memory and is never persisted. After the first successful connection, the backend issues a narrower, revocable device credential. It is stored through the native Even host-storage bridge and lets a later cold start create a new conversation after the 15-minute session-resume window without asking for the master token again. The backend stores only a hash; the device credential rotates on use, expires after 30 idle days, and cannot bypass Calendar/Email confirmations. A valid same-client resume can replace its own stale or half-open transport immediately; another client or an invalid credential cannot take the input lease. A local Vite proxy connects to port 3001 without relaxing backend origin checks. This proxy is development-only and **not included in the client build**. Production builds connect directly to `wss://calendar.eveng2assistant.com`, and the manifest allowlists only that HTTPS/WSS origin plus the G2 microphone permission.

To run the simulator against the deployed backend without exposing its loopback listener, set the development proxy target for the current shell before `npm run dev`:

```powershell
$env:EVEN_DEV_BACKEND_ORIGIN = 'wss://calendar.eveng2assistant.com'
npm run dev
```

The browser and simulator still connect only to `127.0.0.1:5173`; Vite forwards `/ws/conversation` over public TLS port 443 and supplies the backend's exact HTTPS Origin. The value must be a bare WebSocket origin with no path, credentials, query, or fragment. Non-local plaintext `ws://` targets are rejected. Do not put `G2_CLIENT_TOKEN` or any API credential in this setting, source code, or client bundle. Unset the variable to return to the local `ws://127.0.0.1:3001` backend.

With the local backend selected, the Browser companion shows a development-only **session and SQLite lab**. It can simulate a resume, expire the current recovery window, show metadata-only SQLite health, create a fixed synthetic record older than three years, preview retention, and delete only those synthetic records. It does not expose arbitrary SQL, database paths, credentials, session IDs, or conversation text. The panel is removed from production builds; the server also rejects every lab command unless test controls are explicitly enabled on a loopback-only server.

Use Node 24 or newer. On a Windows machine whose TLS inspection root is available only through the system certificate store, start Vite with that same Node binary as `node --use-system-ca .\node_modules\vite\bin\vite.js`; do not disable certificate validation. Older Node versions reject this flag and must not run this project.

`npm run build` emits only this client's `dist/` and then rejects source maps, debug/test directories, unexpected file types, private-key markers and obvious credential assignments. `npm test` tests connection URL validation, lifecycle and bilingual pagination. The `dev/` fixture is dynamically imported only in Vite development mode and removed in production; no mock data is mixed into actual connected conversations. After SDK code changes, restart the simulator if hot reload reports startup-page rejection (the host may retain its old page).

## Even Hub package

Use Node 24+, then run `npm run pack:hub`. The pinned official CLI builds `glass-assistant-0.2.0.ehpk` with SDK `0.0.14` and derives the corresponding Even App floor. The package is ignored by Git. It contains no client token or provider credential; the user supplies the backend access token only for bootstrap and it remains in memory. The separately issued device credential is runtime data in native host storage, never embedded in the package.

The release identity is `Glass Assistant` / `com.eveng2assistant.glassassistant`. The name intentionally does not contain “Even”, which the current Hub review rules reserve for affiliated apps. `npm run pack:hub:check` additionally checks package-ID availability, but first requires an explicit local `evenhub login`; it does not upload or reserve the ID. See [the packaging and Private Testing guide](../../docs/EVEN_HUB_PACKAGING.md) before uploading.

The phone companion already includes an optional text box for exact content such as email addresses, URLs and IDs; the glasses do not provide a keyboard. Source after the `0.2.0` package adds automatic session-only location for route questions, with at most three first/stale-fix attempts, first-use permission guidance, cancellation and typed-origin fallback. After permission succeeds, the SDK is asked for updates at most every 10 seconds. Exact coordinates go only to server-side route/time/environment executors, never the LLM/history/logs, and are cleared on stop, disconnect or session exit. Manual one-shot/continuous controls remain for development diagnostics. This source still needs user local, Linux and real-device acceptance and has not been repacked. The current package is pinned to the maintainer's exact backend and is personal Private Testing only, not a universal public binary. A self-hoster must rebuild with their own exact backend origin and manifest whitelist. See [companion input, location, and safe distribution](../../docs/COMPANION_INPUT_LOCATION_AND_DISTRIBUTION.md) and [Google Maps route setup](../../docs/setup/GOOGLE_MAPS_ROUTES.md).

When the Vite development server is running, the companion page also shows a
**development-only simulated location** panel. Choose one of six public test
points—or let the page pick one randomly—then ask the same nearby-place or ETA
question. The selection stays active for route follow-ups until you switch back
to **Real SDK location**. This fixture is memory-only, never represents the
user's real position, and is deliberately removed from production builds and
Hub packages. It is useful for API comparison, but it does not replace real
phone/G2 permission, accuracy, movement, lock-screen, or lifecycle acceptance.

Display: conservative five-line body plus two status lines; updates coalesced at 300ms, one SDK write in flight, no auto-page jumps. Full answers remain on the backend. This is not pixel-perfect typography: long URLs, emoji/unsupported glyphs and real hardware fonts still need visual validation. Tokens stay in memory only, never URL/storage/logs. Foreground loss and connection loss stop forwarding audio and location. A host foreground-enter event restores the prior microphone intent and reconnects a dropped transport; a reversible `pagehide` does not destroy resumable state. If native `audioControl(true)` reports the known process-lifetime wedge, the client stops retrying and requires a plugin reopen. Real iOS jetsam recovery still depends on the host reopening the plugin and remains a physical-device acceptance item.

Official references: https://hub.evenrealities.com/docs/get-started/quickstart/first-app and https://hub.evenrealities.com/docs/build/device-apis

## Reading experience v2

- Speech starts a user entry labelled 正在说 / 正在识别文字. Delta text is visible; final text replaces the draft. Segment IDs keep overlapping transcription completions ordered. The committed question is preserved in session history.
- The answer opens at its first page unless the user has explicitly started browsing history. New streamed content does not advance the reading position. Bullets and numbered items form semantic pages where possible; oversized items and plain text use consecutive five-line chunks with no overlap or repeated previous lines. Up/Down crosses between question/answer entries only at the beginning or end. The companion “回到最新一条” returns to the newest entry's beginning. A reconnect within the recovery window restores the same server-side session snapshot and bounded recent history; this is not an unrestricted archive browser.
- Glasses display omits HTTP URLs, bare domains and Markdown link syntax while retaining source labels, caveats and timestamps. Raw answers/citations on the server, conversation saves and MD export are untouched. Incomplete ASCII tokens/links may wait briefly for the next chunk; Chinese text remains streaming.
- Interrupted answers remain readable and marked 已打断. Text-input questions also appear in history. Empty/noisy ASR drafts are not claimed to be completed answers.
- `dev/reading-demo.ts` supplies offline visual fixtures only. `dev/exit-probe.html` is a separate SDK-only exit reproduction, with no API, audio or display timer; neither enters the production client bundle or backend release.
