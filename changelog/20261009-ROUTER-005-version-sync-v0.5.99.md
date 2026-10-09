## Summary
Bump `9router-api` version from `0.5.95` → `0.5.99` to match the synced 9router core.

Companion to **vianhanif/9router#??**, which merges upstream `v0.5.99` (commit `ce4460ef`, 2026-10-08) into that repo's master.

No code changes required — this repo consumes 9router as a library via `tsconfig.json` path aliases (`../9router/`), so it picks up the v0.5.99 code automatically at build/run time.

## Compatibility Check

Audited every symbol re-exported from `src/exports.js` against the merged 9router tree. **All 33 resolve — no breakage.**

| Module | Symbols | Status |
|---|---|---|
| `sse/handlers/chat.js` | `handleChat` | OK |
| `sse/services/auth.js` | `markAccountUnavailable`, `clearAccountError` | OK |
| `lib/localDb.js` | `getSettings`, `updateSettings`, `validateApiKey`, provider-connection CRUD, `getCombos`, `getComboByName`, API-key CRUD (13) | OK |
| `lib/auth/dashboardSession.js` | `verifyDashboardAuthToken` | OK |
| `lib/consoleLogBuffer.js` | `initConsoleLogCapture`, `getConsoleLogs`, `getConsoleEmitter`, `clearConsoleLogs` | OK |
| `lib/headroom/process.js` | `startHeadroomProxy`, `stopHeadroomProxy` | OK |
| `lib/mcp/gateway/handler.js` | `handleJsonRpc` | OK |
| `lib/headroom/detect.js` | `DEFAULT_HEADROOM_URL`, `isLoopbackHeadroomUrl`, `findPython310`, `probeProxyRunning` | OK |
| `open-sse/index.js` | `getExecutor`, `hasSpecializedExecutor` | OK |
| `open-sse/handlers/chatCore.js` | `handleChatCore` | OK |
| `open-sse/services/tokenRefresh.js` | `refreshTokenByProvider` | OK |

The 9router changes that touch shared code are additive, so the enhancement layer is unaffected:
- `package.json` — `@aws-sdk/credential-providers` added (Bedrock SSO), `better-sqlite3` remains ^13 (Node >=22)
- `schema.js` — `SCHEMA_VERSION` held at 3 (our MCP migrations); upstream's `apiKeys.accessRestricted/accessAllow` additive
- `models/route.js` — per-key access gate (`filterModelsListForKey`) applied before query filters
- `chatCore.js` — transport guard: supported-sourceFormat uses our Responses capability gate; unsupported branch falls back to model's targetFormat transport

## Testing
- `npm run build` passes (esbuild bundle, 299.3kb).
- `npx vitest run src/supervisedExecutor.test.ts src/routes.test.ts` → **15/15 pass**.

## Risks / Limitations
- **Version marker only** — no runtime behavior change in this repo.
- `Dockerfile` defaults to `NINEROUTER_VERSION=master`, so a Docker build will pull upstream `master` rather than exactly v0.5.99. For exact parity use `--build-arg NINEROUTER_VERSION=v0.5.99`. Left unchanged — pinning is a separate policy decision.

## Notes
- Changelog entry added at `changelog/20261009-ROUTER-005-version-sync-v0.5.99.md`, following the existing ROUTER version-sync convention.
