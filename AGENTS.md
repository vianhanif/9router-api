# AGENTS.md

## Context
Operational contract for any agent working in this repo.

## Project
9router-api — standalone LLM API server that wraps the 9router codebase as a library. Provides OpenAI-compatible endpoints without the dashboard UI.

## Architecture

```
server.ts          → Express entry point, port 20127
src/exports.js     → Re-exports from 9router
src/mcpGateway.ts  → MCP gateway handlers
src/supervisedExecutor.ts → Auto-retry + heartbeat guard (enhancement layer)
```

The `src/supervisedExecutor.ts` is 9router-api's own enhancement layer. 9router core stays untouched.

## Code Boundaries

- **`src/supervisedExecutor.ts`** — 9router-api owned. Auto-retry, heartbeat, circuit-breaker.
- **`src/mcpGateway.ts`** — MCP gateway, delegates to 9router's `handleJsonRpc`.
- **`src/exports.js`** — thin re-export shim, no business logic.
- Everything else (`server.ts`) — orchestration, no provider/translator logic.

## Conventions

- Plain JavaScript/TypeScript (ESM).
- Import path aliases via `tsconfig.json` (`@/*` → `./src/*`).
- No direct import of 9router internal paths — always through `src/exports.js`.
- SupervisedExecutor lives in 9router-api only; it is the "enhancement layer" sitting above `handleChat`.

## Testing

```bash
npm install
npx vitest run src/supervisedExecutor.test.ts
```

## Commit Style

Conventional Commits:
- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation
- `refactor:` — code restructure
- `test:` — tests only

## Branch Model

- `master` — default, production-ready
- `feature/ROUTER-NNN-description` — feature branches
- PRs target `master`
