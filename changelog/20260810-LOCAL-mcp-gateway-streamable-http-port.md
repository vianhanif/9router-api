# 20260810-LOCAL — Port MCP Gateway (Streamable HTTP) into 9router-api

## Section 1 — Task Overview

### What
Expose the 9router MCP gateway as `POST /api/mcp-gateway` on the existing 9router-api Express listener (`:20127`). Serving only — no CRUD/management routes. Streamable HTTP transport only (no SSE transport, no `sseSessions.js`).

### Why
Clients currently point at the Next.js dashboard gateway (`http://localhost:20128/api/mcp-gateway`). Serving from 9r-api lets the gateway run even when the dashboard is down, on the lighter API-only process. Dashboard stays untouched (master, `:20128`) and keeps owning instance/key management.

### Success criteria
- `curl -X POST http://localhost:20127/api/mcp-gateway` with `Authorization: Bearer <gateway-key>` answers `initialize`, `tools/list`, `tools/call` identically to the `:20128` endpoint.
- Bad/missing key → 401 with JSON-RPC error `-32000`.
- Notifications (`notifications/initialized`) → HTTP 202, empty body.
- `GET /api/mcp-gateway` → 405, `Allow: POST`.
- Gateway works with the 9router dashboard process stopped.
- stdio MCP children die cleanly when `pm2 restart 9r-api` / SIGTERM / SIGINT.
- Zero changes in `/Users/pid-alvian/Documents/alvian/9router`.

## Section 2 — Scope Table

| # | Scope | Repository / Service | Complexity | Recommended LLM |
|---|-------|----------------------|------------|-----------------|
| 1 | Express route + adapter for `handleJsonRpc`, stdio shutdown hook | 9router-api (only) | Medium | Mid-tier (Claude Sonnet) |

## Section 3 — Verified Contract (source of truth)

### 3.1 Next.js shell → `handleJsonRpc` contract
From `../9router/src/app/api/mcp-gateway/route.js` (14-37):
- Shell does `body = await request.json()`; on parse failure returns **400** `{jsonrpc:"2.0", id:null, error:{code:-32700, message:"parse error"}}`.
- Calls `handleJsonRpc(request, body)` — request used ONLY for headers + URL (auth); body passed separately, already parsed. **No raw-body requirement.**
- Return shapes (verified in `../9router/src/lib/mcp/gateway/handler.js:62-146`):
  - `{kind:"notification"}` → HTTP **202**, empty body.
  - `{kind:"response", status, body}` → JSON with `status || 200`. Statuses used: 401 (auth), 400 (bad envelope), 200 (everything else, including JSON-RPC errors).
  - `out.items` fallback exists in the shell but the handler never returns it — ignore.
- GET → **405**, body `{jsonrpc:"2.0", id:null, error:{code:-32000, message:"POST JSON-RPC requests"}}`, headers `Content-Type: application/json`, `Allow: POST`.
- **No `Mcp-Session-Id` response header** — gateway is stateless per POST; session IDs only used internally toward upstreams (`httpClient.js`).

### 3.2 What `handleJsonRpc` reads from `request`
`handler.js:15-30` (`extractApiKey`):
- `request.headers.get("Authorization")` → `Bearer <key>`
- `request.headers.get("x-api-key")`, `request.headers.get("x-goog-api-key")`
- `new URL(request.url).searchParams.get("key")` — so `request.url` must be an absolute URL string.

That is the ENTIRE surface: `headers.get(name)` + `url`. The existing `wrapExpressRequest` in `server.ts:141-197` already builds exactly this shape (`headers.get` via `req.get(name)`, absolute `url`). Express header lookup is case-insensitive, matching Web `Headers.get` semantics.

### 3.3 Body parsing — no conflict
Global `express.json({limit:'50mb'})` (`server.ts:39`) pre-parses the body. This is fine: the shell only needs the parsed object, which we take from `req.body`. No raw Request reconstruction needed. One gap: `express.json()` responds 400 with an HTML/Express error on malformed JSON *before* our route runs, instead of the JSON-RPC `-32700` envelope. Acceptable (still 400); optionally add a JSON error middleware later — out of scope.

Note: Express 5 leaves `req.body` `undefined` when there is no body or wrong `Content-Type`. Handler treats non-object as invalid envelope → 400 `-32600`. Acceptable.

### 3.4 Auth flow
`handler.js:40-53`: `validateGatewayKey(rawKey)` → `getGrantsForKeyDetailed(keyRow.id)` → `getEnabledInstancesByIds(...)`. All from `@/lib/localDb` (shim over `@/lib/db/index.js`). All reachable via existing tsconfig alias `@/*` → `../9router/src/*`.

### 3.5 Env/config the gateway lib reads
- **No `REQUIRE_API_KEY`** anywhere in `9router/src` (grep verified) — auth is always enforced via gateway keys.
- DB path: `../9router/src/lib/db/paths.js` → `DATA_DIR` from `../9router/src/lib/dataDir.js` → env `DATA_DIR` or default `~/.9router`. **`NINEROUTER_HOME` is NOT read by any 9router source code** (grep verified — it appears only in 9r-api's `ecosystem.config.cjs` and README, unused). Live DB confirmed at `~/.9router/db/data.sqlite`. Since 9r-api already runs chat handlers against the same DB layer, no env change needed. Do not set `DATA_DIR`.
- No other env consumed by `handler.js` / `aggregator.js` / `httpClient.js` / `stdioClient.js` (stdio spawns inherit `process.env` + per-instance env).

### 3.6 DB adapter behavior under 9r-api
`../9router/src/lib/db/driver.js`: Node order = better-sqlite3 → node:sqlite → sql.js.
- Imports resolve relative to the 9router repo, so `better-sqlite3` in `../9router/node_modules` is found (verified present, compiled `build/` exists) — 9r-api will most likely get the **better-sqlite3** adapter with WAL (shm/wal files present), giving real shared read/write with the dashboard process. Good: instance/key edits in the dashboard are visible to 9r-api on next query (repos query per call, no long-lived cache).
- If native bindings fail under Node v26, fallback is node:sqlite (also fine, WAL) then sql.js. **sql.js is the only risky case**: full in-memory copy, debounced whole-file `writeFileSync` — 9r-api writes (`saveRequestUsage`, OAuth `updateInstance` token refresh) could clobber concurrent dashboard writes, and dashboard edits are invisible until restart. Accepted per requirements; log line `[DB] Driver: ...` at startup tells us which adapter won — check it once after deploy.
- Writes 9r-api will perform: `saveRequestUsage` per tools/call, `updateInstance` (oauthTokens) on token refresh / 401 flagging (`httpClient.js:138-147`, `oauthRefresh.js:113`). With WAL adapters both processes writing is safe (SQLite busy-wait); low volume.

### 3.7 stdio child lifecycle
`stdioClient.js` stores children in `globalThis.__9routerGatewayStdio` (Map of instanceId → StdioEntry with `.proc`). Children spawn lazily on first tools/list-or-call for a stdio instance; they become children of the 9r-api PM2 process. There is **no kill helper in the lib** — the dashboard relies on process exit. On PM2 stop, SIGTERM to the tree usually kills children, but detached/ignoring children can leak. Plan: explicit cleanup in `server.ts` `shutdown()` — iterate the global store and `proc.kill("SIGTERM")` each alive entry. Zero upstream changes required since the store is on `globalThis`.

## Section 4 — Change Plan (9router-api ONLY)

### Files to create
1. `src/mcpGateway.ts` — Express handlers:
   - `postMcpGateway(req, res)`:
     - Build the minimal request shim (same shape as `wrapExpressRequest`'s `webRequest`: `{ url, headers: { get } }`).
     - Guard: if `req.body` is not a plain object/array → respond 400 with `-32700` parse-error envelope (covers empty/missing body).
     - `const out = await handleJsonRpc(webRequest, req.body)`.
     - `out.kind === "notification"` → `res.status(202).end()`.
     - else → `res.status(out.status || 200).json(out.body)`.
     - try/catch → 500 `{jsonrpc:"2.0", id:null, error:{code:-32603, message:"internal error"}}`.
   - `getMcpGateway(req, res)`: 405, `Allow: POST`, JSON-RPC `-32000` body (mirror route.js GET).
   - `shutdownStdioChildren()`: read `globalThis["__9routerGatewayStdio"]`, for each entry with a live `proc` call `proc.kill("SIGTERM")`; clear the map. Defensive: wrap in try/catch, never throw.
2. `changelog/20260810-LOCAL-mcp-gateway-streamable-http-port.md` — this doc.

### Files to modify
1. `src/exports.js` — add:
   - `export { handleJsonRpc } from '@/lib/mcp/gateway/handler.js';`
   (Keeps the established pattern: server.ts imports only from `./src/exports.js`.)
2. `server.ts`:
   - Import `postMcpGateway`, `getMcpGateway`, `shutdownStdioChildren` from `./src/mcpGateway.ts` (or inline import of handleJsonRpc via exports.js — prefer the module for testability).
   - Register after the LLM endpoints section: `app.post('/api/mcp-gateway', postMcpGateway); app.get('/api/mcp-gateway', getMcpGateway);` (OPTIONS already handled by global CORS middleware).
   - In `shutdown()` (server.ts:261-276), before `process.exit(0)`, call `shutdownStdioChildren()`.

### Order of changes
1. `src/exports.js` (export handleJsonRpc)
2. `src/mcpGateway.ts` (handlers + shutdown helper)
3. `server.ts` (routes + shutdown hook)
4. Manual test (Section 6), then `pm2 restart 9r-api`
5. Client config migration (outside repo): change gateway URL `http://localhost:20128/api/mcp-gateway` → `http://localhost:20127/api/mcp-gateway` in `~/.claude/mcp.json` / opencode config. Keys unchanged.

### Explicitly NOT ported
- `9router/src/app/api/mcp-gateway/sse/` and `message/` routes, `sseSessions.js`.
- All instance/key/grant CRUD and OAuth authorize routes — stay dashboard-only.
- No new npm deps; no tsconfig changes (aliases already cover `@/*`).

## Section 5 — Risks / Side Effects

1. **Dual gateway processes spawn duplicate stdio children.** Dashboard on :20128 and 9r-api on :20127 each keep their own child per stdio instance (separate `globalThis`). Duplicated RAM + possible duplicate side effects for stateful stdio servers. Mitigation: migrate clients to :20127 and stop using :20128 for MCP; instances spawn lazily so the dashboard side stays dormant if unused.
2. **OAuth token refresh races.** Both processes can refresh the same instance's token concurrently → last-write-wins on `oauthTokens`. Rotating refresh tokens could invalidate one side until re-auth. Low likelihood (refresh leeway 60s, in-flight dedupe is per-process only). Accepted.
3. **sql.js fallback** (only if both better-sqlite3 and node:sqlite fail): stale reads + clobbered writes across processes. Check the `[DB] Driver:` startup log; if sql.js, treat as deploy blocker and fix native module build instead.
4. **`express.json()` 50mb limit + malformed-JSON error shape** differ slightly from the Next.js shell (Next returns JSON-RPC `-32700`; Express returns its own 400). Cosmetic; harnesses treat 400 as failure either way.
5. **Usage rows** now written from 9r-api (`saveRequestUsage` with `endpoint: "/api/mcp-gateway"`), visible in the dashboard usage view — intended, no schema impact.
6. **stdio child leak on SIGKILL** (`pm2 delete` with force): shutdown hook won't run; orphans possible. Same behavior as today's dashboard. Accepted.
7. Backward compatible: no existing 9r-api route touched; dashboard untouched.

## Section 6 — Manual Test Scenarios

Prep: `KEY=<gateway key from dashboard>` (must have grants to ≥1 enabled instance, ideally one http + one stdio).

### Happy path
```
# initialize
curl -s -X POST http://localhost:20127/api/mcp-gateway \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# expect: 200, result.protocolVersion "2025-06-18", serverInfo.name "9router-gateway"

# tools/list
curl -s -X POST http://localhost:20127/api/mcp-gateway \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
# expect: 200, tools[] with slug__toolName names; also verifies x-api-key path

# tools/call (pick a cheap tool from the list)
curl -s -X POST http://localhost:20127/api/mcp-gateway \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"<slug>__<tool>","arguments":{}}}'
# expect: 200, result.content[]
```

### Edge cases
```
# bad key → 401, error.code -32000 "gateway key invalid"
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:20127/api/mcp-gateway \
  -H "Authorization: Bearer nope" -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' -H "Content-Type: application/json"

# missing key → 401 "gateway key missing"
# unknown tool → 200 with error.code -32602 "unknown tool: bogus__x"
curl -s -X POST http://localhost:20127/api/mcp-gateway \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"bogus__x"}}'

# notification → 202 empty
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:20127/api/mcp-gateway \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# GET → 405 with Allow: POST
curl -s -i http://localhost:20127/api/mcp-gateway

# stdio instance: tools/call against a stdio-transport instance, then
# `pgrep -f <stdio command>` to confirm child under 9r-api; pm2 restart 9r-api;
# confirm old child is gone (no orphan) and next call respawns it.
```

### Failure scenario
```
# Stop the dashboard: pm2 stop <dashboard app> (or kill :20128 process)
# Re-run tools/list against :20127 — MUST still return 200.
# Restart dashboard afterward.
```

## Section 7 — Branch & Rollback

- Repo default branch: confirm at coding-session start (per rules, never auto-assume). Feature branch: `feature/LOCAL-mcp-gateway-port`.
- Rollback: revert the 3-file change (delete `src/mcpGateway.ts`, revert `server.ts` + `src/exports.js` hunks), `pm2 restart 9r-api`, point client configs back to `http://localhost:20128/api/mcp-gateway`. No DB migration, no data cleanup needed (usage rows are append-only and harmless).
