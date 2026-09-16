# Project and deployment boundaries

One repository, no second project root. Keep existing backend paths stable.

| Path | Responsibility | Linux server release |
| --- | --- | --- |
| `src/` | Backend; historical inject/POC entry points are development-only | Only compiled conversation-server entry and its imports |
| `web/` | Existing browser conversation lab | Excluded |
| `clients/even/` | Real Even SDK client, with its own package/lock/tsconfig; dev-only layout fixture | Excluded; built separately for Even Hub |
| `tools/even-simulator/` | Simulator dependency/configuration and launch tooling | Excluded |
| `tests/` | Offline tests, live checks, recordings | Excluded |
| `scripts/` | Build tooling | Excluded |
| `deploy/` | Reviewed service templates | Explicit service file only |
| `docs/` | Development documentation | Excluded |
| `.local/`, `.env` | Local private data/configuration | Never copied |
| `dist/server-*` | Fresh server-only build output | Deploy exactly one successful build |

Simulator dependencies must not be added to the backend runtime dependencies. The SDK client is a product component, not the simulator; its release artifact is independent. Local simulator integration now exists; production Even Hub packaging/network configuration remains pending.

## Server release

1. In the development checkout: `npm ci`, `npm run typecheck`, `npm test`, `npm run build:server`.
2. Use only the successful build directory printed by the command. Inspect `BUILD-MANIFEST.json`. Failed builds lack a completed manifest and must not be deployed.
3. Copy that directory's contents to `/opt/even-agent`. Never copy the entire repository or Windows node_modules.
4. On Linux run `npm ci --omit=dev`. The package retains lock-aligned dev dependency metadata, but these dependencies are not installed. Runtime uses compiled JS, not tsx or TypeScript.
5. Configure `/etc/even-agent.env` separately; data belongs in `/var/lib/even-agent`, CLI auth belongs to the service account. See LINUX_OPERATIONS.md.

The build follows imports from a single backend entry point, explicitly copies the two CLI runtime resources, and validates an output allowlist. Every build uses a fresh directory, so stale frontend/debug files cannot leak into a later release. No source maps or TS tests are emitted. The production package intentionally has no browser lab: `/` returns 404; the conversation WebSocket and authenticated artifact endpoints remain. A future Even client networking/origin policy needs separate integration and review; this package is not yet a public Internet deployment.

Keep the existing browser lab running from the checkout via `npm run conversation`. Do not move files merely for cosmetic restructuring. Add the SDK client and simulator in their designated areas, with separate build commands and release artifacts.
