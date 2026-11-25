# v0.5.123 Version Sync

**Date:** 2026-11-25
**Upstream:** 9router v0.5.123 (5ae63d22, 2026-11-22)

Upstream shipped no tags for 0.5.120–0.5.122; this is the next release after v0.5.119.

## Changes
- Sync 9router-api version 0.5.119 → 0.5.123 to track upstream release
- No API-specific code changes; release version pin only

## Upstream Highlights
- **antigravity:** Gemini 4 Hydrogen, live model catalog, IDE identity/UA alignment, fake-429 prompt stripping
- **kiro:** Kiro IDE 1.4.154 identity on every call and token refresh, `/v1/responses` fallback on 429
- **cloudflare-ai:** deprecated model pruning, System One catalog, `customUpstreamModelId`
- **nvidia:** live embedding models + `input_type`, Nemotron 3 Ultra tools/1M window
- **elevenlabs:** refreshed TTS models, live list, OpenAI `voice` field honored
- **models:** GPT 6.2 Sol/Astra, Mistral Large 4 limits, Kimi K3.1 Code limits
- **providers:** OpenDesign Go, DeepRelay, Alibaba Token Plan dual endpoint
- **token-saver:** REA allow prompt toggle
- **deps:** next 16.4.6, node-forge 1.4.3

## For Deployment
- undici stays `^7.30.2`, undici still externalized + traced via next.config.mjs
- Node floor unchanged: `engines.node >=20.18.1` (image uses 22.23.4)
