# ROUTER-008: Version Sync v0.5.112

**Objective:** Sync 9router-api version to match upstream 9router v0.5.112.

## Changes
- package.json: 0.5.109 → 0.5.112

## Upstream notable additions (v0.5.112)
- Ollama TTS/embeddings
- Nace Drex
- Runcrate
- Codex GPT-6.1 Terra
- MiniMax lease auth
- CommandCode 1.88 headers
- OpenCode TLS client
- DeepSeek PoW noble-hashes
- Dockerfile lazy runtime deps

## Validation
- npm install: OK
- POST /api/health: {"version":"0.5.112"}
