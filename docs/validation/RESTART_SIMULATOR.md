# Restart the local simulator (Windows)

Double-click `scripts/restart-simulator.cmd`, then choose **1 Local** or **2 Linux**.
The launcher opens the native glasses simulator and the browser client. Check the
browser backend label before connecting; enter your token in the UI, not in command arguments.

```powershell
# Restart local backend + frontend + simulator
.\scripts\restart-simulator.ps1 -Target Local
# Restart frontend + simulator, connect to the configured production WSS endpoint
.\scripts\restart-simulator.ps1 -Target Linux
# Optional: another self-hosted server
.\scripts\restart-simulator.ps1 -Target Linux -LinuxOrigin wss://assistant.example.com
# Dependencies/config only; no restart
.\scripts\restart-simulator.ps1 -Target Local -CheckOnly
```

Linux mode never deploys, restarts or uploads credentials to the server. It leaves
any local backend running. Local mode interrupts local work: finish pending email
or calendar operations before restarting, and reconcile uncertain writes instead
of blindly retrying. Recent place candidates may need a fresh search after restart.

Requires Windows, Node 24+, and installed dependencies at the project root,
`clients/even`, and `tools/even-simulator`. `-NodePath` selects a Node executable.
The Codex bundled runtime is preferred when available; otherwise Node from PATH is used.
Logs remain in ignored `.local/simulator-launcher/`; they may contain private data.

Only processes launched with this workspace's absolute entry paths are replaced.
An older manually launched process using relative paths must be closed once manually
if it occupies ports 3001, 5173 or 9898. Unrelated processes are never killed by port.
No session database or credential storage is cleared. `-NoBrowser` skips opening a browser tab.
The CMD wrapper's execution-policy override applies only to its child PowerShell process;
it does not change the machine's execution policy or require administrator privileges.

Verified locally on 2026-09-21: both preflight modes; Local startup; Local → Linux → Local restart;
Linux frontend label includes the remote host and port 443; final local health check returns 200.
This verifies launch/target switching, not an authenticated production conversation.
