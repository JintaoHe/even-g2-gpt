# Even SDK client (local simulator integration)

Independent package, lockfile, TypeScript and Vite build. No API key belongs here.

1. Start the existing root backend: `npm run conversation` (port 3001, API default).
2. Here: `npm ci`, then `npm run dev` (127.0.0.1:5173 only).
3. Start the simulator from `tools/even-simulator` (see its README).
4. In the simulator's **Browser** companion window enter the local G2_CLIENT_TOKEN and connect. Disconnect any old browser conversation first; the backend permits one active owner. The **Glasses Display** window is the actual SDK output, not the HTML preview.
5. Send text, use Up/Down to change pages. Explicitly enable the mic to test continuous voice; entering the app does not start recording. Click toggles capture; Double Click stops capture and requests the native system exit dialog. If cancelled, use the companion resume control; capture never restarts automatically.

The channel label comes from the authenticated backend. API keys stay there; audio is still API STT. A local Vite proxy connects to port 3001 without relaxing backend origin checks. This proxy is development-only and **not included in the client build**. The app manifest is a local development identity, not a production-ready Hub submission. Remote hosting, network permission allowlists, TLS and packaged WebSocket URL configuration remain separate work.

`npm run build` emits only this client's dist. `npm test` tests bilingual pagination. The `dev/` fixture is dynamically imported only in Vite development mode and removed in production; no mock data is mixed into actual connected conversations. After SDK code changes, restart the simulator if hot reload reports startup-page rejection (the host may retain its old page).

Display: conservative five-line body plus two status lines; updates coalesced at 300ms, one SDK write in flight, no auto-page jumps. Full answers remain on the backend. This is not pixel-perfect typography: long URLs, emoji/unsupported glyphs and real hardware fonts still need visual validation. Tokens stay in memory only, never URL/storage/logs. Exit/unload, foreground loss and connection loss stop forwarding audio.

Official references: https://hub.evenrealities.com/docs/get-started/quickstart/first-app and https://hub.evenrealities.com/docs/build/device-apis

## Reading experience v2

- Speech starts a user entry labelled 正在说 / 正在识别文字. Delta text is visible; final text replaces the draft. Segment IDs keep overlapping transcription completions ordered. The committed question is preserved in session history.
- The answer opens at its first page unless the user has explicitly started browsing history. New streamed content does not advance pages. Up/Down crosses between question/answer entries at page boundaries; the companion “回到最新一条” returns to the newest entry's first page. History is in-memory for this connection; reconnect starts a new session, not a server archive browser.
- Glasses display omits HTTP URLs, bare domains and Markdown link syntax while retaining source labels, caveats and timestamps. Raw answers/citations on the server, conversation saves and MD export are untouched. Incomplete ASCII tokens/links may wait briefly for the next chunk; Chinese text remains streaming.
- Interrupted answers remain readable and marked 已打断. Text-input questions also appear in history. Empty/noisy ASR drafts are not claimed to be completed answers.
- `dev/reading-demo.ts` supplies offline visual fixtures only. `dev/exit-probe.html` is a separate SDK-only exit reproduction, with no API, audio or display timer; neither enters the production client bundle or backend release.
