# v0.5.119 Version Sync

**Date:** 2026-11-16
**Upstream:** 9router v0.5.119 (d1970ac9, 2026-11-13)

## Changes
- Sync 9router-api version 0.5.116 → 0.5.119 to track upstream release
- No API-specific code changes; release version pin only

## Upstream Highlights
- **Providers:** synthetic.new (+ `/v2/quotas` key validation), Clinepass quota tracker, CommandCode live catalog
- **Models:** Claude Fable 5.2 / Haiku 5.5, Gemini 4 Carbon, retire Fable 5.1, gemini-4 pricing fix
- **Discovery:** `thinking_levels` on `/v1/models`, opencode effort variants, Claude live model list via OAuth
- **Transport:** undici back to `^7.30.2` (8.x requires Node >=22.19), `engines.node >=20.18.1`; STT uses undici FormData
- **Streaming:** single `[DONE]` sentinel on passthrough streams
- **Compat:** stop advertising zstd when the runtime cannot decode it

## For Deployment
- Node floor now declared: >=20.18.1 (deploy image uses 22.23.4 — unaffected)
- undici 7.30.2 still externalized + traced via next.config.mjs
