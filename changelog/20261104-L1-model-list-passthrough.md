# L1: `/v1/models` passthrough to core 9router

**Objective:** Stop `9router-api` from serving a hardcoded single-model list on the
hyphenated host (`9router.vianhanif.link` → Caddy → `9router-api:20127`) while the
real instance exposes 85 models (14 combos + 71 provider models).

## Root cause
`server.ts` had a stub:

```ts
app.get('/v1/models', async (req, res) => {
  // TODO: Wire up models handler from 9router
  res.json({ object: 'list', data: [{ id: 'gpt-4o', ... }] });
});
```

Caddy routes `9router.vianhanif.link` to `9router-api`, so clients got that one
bogus model instead of the real list. The correct implementation already exists
in core 9router (`src/app/api/v1/models/route.js`, served at `/v1/models` and
`/api/v1/models`): combos first with min-of-seats limits, `capability`,
`min_context`, `kind`, `q`, `limit` filters, and per-API-key restriction
(`access.allow` / `access.restricted`).

## Change
- `server.ts`: `/v1/models` now proxies `GET ${NINEROUTER_CORE_URL}/v1/models<raw querystring>`.
  - `authorization` forwarded verbatim so core enforces the key and per-key model filtering.
  - Raw querystring forwarded untouched (repeated `?capability=` params survive).
  - Upstream status + JSON body mirrored verbatim (so 400/401 envelopes reach the caller).
  - Non-JSON response, network error, or 5s timeout (`AbortSignal.timeout`) → `503`
    `{ error: { message: "Model list unavailable", type: "service_unavailable" } }`.
  - No cache, no retries, no new dependency. Invariant documented in-code: core
    is the single source of truth for model lists.
- `src/routes.test.ts`: proxy tests with stubbed `global.fetch` — 200 passthrough
  (URL + `authorization` asserted), 401 propagation, network failure → 503,
  repeated `capability` params preserved, non-JSON → 503 (never the old payload).

## Environment variable
| Var | Default | Purpose |
|---|---|---|
| `NINEROUTER_CORE_URL` | `http://9router:20128` | Core 9router base URL (compose service name/port). Default is correct for the compose network; set it when running outside compose. |

## Deploy note
Needs a new image tag and a `PIN_9ROUTER_API` bump in the `9router-deploy` repo
(the proxy hop only works once the new `9router-api` image is running). No new
env var is required in `env/9router-api.env` — the default points at the
`9router` compose service.

## Validation
- Probe from inside `9router-api` container on `tencent-cloud`:
  `http://9router:20128/v1/models` → **401** `application/json`
  `{"error":"API key required for remote API access"}` (same for `/api/v1/models`),
  i.e. the target is reachable and needs the caller's key — exactly what the
  passthrough forwards.
- `npx vitest run` → 2 files, **20 tests passed** (`src/routes.test.ts` 7/7,
  `src/supervisedExecutor.test.ts` 13/13).
  Note: `src/routes.test.ts` cannot even import `server.ts` on a machine where
  the sibling `9router` repo has no `node_modules` (pre-existing: `HEAD` fails
  the same way with `Cannot find module 'ajv/dist/2020.js'`, `bcryptjs`,
  `node-machine-id`, `undici`); the run above used a temporary local config that
  stubs exactly those sibling-only deps, not committed.
- `npm run build` → esbuild bundle OK for the changed handler. Plain
  `npm run build` is blocked locally by the same missing sibling `node_modules`
  (identical failure on `HEAD`); the bundle resolves them inside the Docker build
  (stage 1 runs `npm install` in `/app/9router`).
