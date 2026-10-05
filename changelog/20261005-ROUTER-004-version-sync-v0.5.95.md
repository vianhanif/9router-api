## Summary
Bump 9router-api version from 0.5.75 to 0.5.95 to match synced 9router core (v0.5.95 tag, PR #36 in vianhanif/9router). The enhancement layer (`supervisedExecutor.ts`, `mcpGateway.ts`) remains compatible — all 34 re-exported symbols verified present in upstream.

## JIRA
N/A

## Testing
- `npm run build` passes (esbuild bundle succeeds).
- All `src/supervisedExecutor.test.ts` + `src/routes.test.ts` tests pass (39/39).
- Verified all re-exported symbols from `src/exports.js` (`handleChat`, `handleJsonRpc`, `handleChatCore`, DB/auth/headroom helpers, open-sse core) still exist in 9router v0.5.95.

## Risks / Limitations
- Version tag only; runtime behavior unchanged. 9router-api consumes 9router via tsconfig path aliases (`../9router/`), so it picks up the v0.5.95 code automatically at build/run time.
- Dockerfile defaults to `NINEROUTER_VERSION=master` (not pinned) — users who need exact parity should override `--build-arg NINEROUTER_VERSION=v0.5.95` at build time.