## Summary
Restore headroom compression in 9router-api by serving the removed `/v1/compress` HTTP contract in-process (`src/headroomCompressShim.ts`). headroom-ai 0.5.x dropped that endpoint from its proxy, so every compression call failed open with HTTP 404 and headroom silently stopped compressing. The shim intercepts loopback `/v1/compress` POSTs and delegates to headroom-ai's Python `compress()` via a persistent worker, with fail-open behavior when Python/headroom-ai is unavailable, and a per-request timeout that also bounds the worker READY wait (slow/unhealthy worker fails open within the budget).

## JIRA
N/A

## Testing
- Boot smoke: `PORT=21099` server starts, `/api/health` returns ok, SIGTERM shuts down cleanly (`stopCompressWorker` kills the Python worker).
- `npx tsc --noEmit`, `npm run build`, `npx vitest run src/supervisedExecutor.test.ts`.
- Compress request against the shim returns `{ messages, tokens_before, tokens_after, tokens_saved }`; when Python/headroom-ai is unavailable it returns the ORIGINAL messages (fail-open) within the per-request timeout.
- Prewarm gated: no Python worker forks at boot when headroom is disabled, the URL is non-loopback, or settings are unavailable (deferred to first compress call).

## Risks / Limitations
- Requires a Python >= 3.10 with `headroom-ai` installed; otherwise compression fails open silently (original request body unchanged).
- The shim only intercepts loopback targets — external (non-loopback) `/v1/compress` proxies are left untouched.
- The single Python worker serializes requests; a wedged worker is killed and respawned on the next request.
- Depends on `probeProxyRunning` from 9router `detect.js` (committed on 9router master), re-exported via `src/exports.js` — no 9router internal paths imported directly.

## Before vs After
### Before
- `{headroomUrl}/v1/compress` POST returns HTTP 404 against headroom-ai 0.5.x; compression silently disabled (`skipped: proxy returned HTTP 404` in error log).
- Health probe in `server.ts` duplicated the /health check inline.

### After
- `/v1/compress` is served in-process; compression works again with the same response shape (`messages`, `tokens_before`, `tokens_after`, `tokens_saved`).
- `server.ts` reuses 9router's `probeProxyRunning` for the already-running guard.