## Summary
Bump 9router-api version from 0.5.69 to 0.5.75 to match the synced 9router core (PR #31). No API changes required — the standalone server's enhancement layer (`supervisedExecutor.ts`, `mcpGateway.ts`) remains compatible with the v0.5.75 exports surface.

## JIRA
N/A

## Testing
- `npm run build` passes (esbuild bundle succeeds).
- All `src/supervisedExecutor.test.ts` tests pass (35/35 across 3 test files).
- Verified all re-exported symbols from `src/exports.js` (`handleChat`, `handleJsonRpc`, `handleChatCore`, DB/auth/headroom helpers) still exist in 9router v0.5.75.

## Risks / Limitations
- Version tag only; runtime behavior unchanged. 9router-api consumes 9router via tsconfig path aliases (`../9router/`), so it picks up the v0.5.75 code automatically at build/run time.