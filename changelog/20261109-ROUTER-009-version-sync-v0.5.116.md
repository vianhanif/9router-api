# v0.5.116 Version Sync

**Date:** 2026-11-09  
**Upstream:** 9router v0.5.116 (1339107e, 2026-11-08)

## Changes
- Sync 9router-api version 0.5.112 → 0.5.116 to track upstream release
- No API-specific code changes; this is a release version pin

## Upstream Highlights
- **CommandCode** 1.88.5 data bridge with auto-import
- **Models:** SenseNova 6.8-flash, GLM 5.3, Codex GPT Image 2.6, Gemini 4 Argon quota tracking
- **Networking:** ProxyFetch keep-alive dead socket fix (DPI networks), undici ^8.12.3 major bump
- **DeepSeek** thinking budget preservation on compat nodes
- **CLI** launcher process optimization (~2.5x startup)
- **TTS** voice list public endpoint (no auth required)
- Test coverage: unit tests for lazy runtime scope, web-fetch formats, CLI tooling

## For Deployment
- next.config.mjs now externalizes undici with tracing includes
- Dockerfile lazy-runtime deps (wreq-js, playwright-core) already in place from v0.5.112
