## Summary
Bump 9router-api version from 0.5.55 to 0.5.69 to match the synced 9router core (PR #29). No API changes required — the standalone server's enhancement layer (`supervisedExecutor.ts`, `mcpGateway.ts`) remains compatible with the v0.5.69 exports surface.

## JIRA
N/A

## Testing
- `npm run build` passes (esbuild bundle succeeds).
- Verified all re-exported symbols from `src/exports.js` (`handleChat`, `handleJsonRpc`, `refreshTokenByProvider`, `handleChatCore`, DB/auth/headroom helpers) still exist in 9router v0.5.69.

## Risks / Limitations
- Version tag only; runtime behavior unchanged. 9router-api consumes 9router via tsconfig path aliases (`../9router/`), so it picks up the v0.5.69 code automatically at build/run time.
