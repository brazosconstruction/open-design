# 001: Hermes Local Bridge

## Question

Given Open Design can call an OpenAI-compatible endpoint, can a local bridge use Hermes' existing OAuth providers (`openai-codex`, `xai-oauth`) so Open Design can experiment with subscription-backed access without storing OAuth tokens on Vercel?

## Approach

Build a throwaway Node HTTP server exposing:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

The bridge accepts OpenAI-compatible chat requests, converts the messages into a Hermes prompt, runs:

```bash
hermes --provider <provider> chat -q <prompt> -Q
```

and returns either OpenAI-compatible JSON or simple SSE events.

This first spike deliberately uses Hermes as a subprocess. It validates auth/provider feasibility before any production integration or token handling.

## Run

```bash
cd /Volumes/External\ Storage/open-design/spikes/001-hermes-local-bridge
HERMES_BRIDGE_PROVIDER=openai-codex \
HERMES_BRIDGE_TOKEN='<generated-local-token>' \
node bridge.mjs
```

## Curl

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer bridge-test-token' \
  -d '{"model":"gpt-5.5","stream":true,"messages":[{"role":"user","content":"Reply with exactly BRIDGE_OK"}]}'
```

## Execution evidence

- Hermes provider preflight:
  - `openai-codex` returned `CODEX_OK`
  - `xai-oauth` returned `XAI_OK`
- Local bridge health returned `{ "ok": true, "provider": "openai-codex", "mode": "hermes-subprocess-spike" }`
- Local bridge model discovery returned `gpt-5.5` and `grok-test` from `/v1/models`
- Direct bridge OpenAI-compatible SSE returned `OPENAI_SSE_OK`
- Cloudflare tunnel health returned OK at `https://zinc-medieval-phoenix-voltage.trycloudflare.com`
- Production Open Design proxy test succeeded:
  - `https://designer.patrickkemp.com/api/proxy/stream` -> tunnel -> local Hermes bridge -> `openai-codex` returned `OD_PROXY_CODEX_2_OK`
  - same route with `model: grok-test` -> local Hermes bridge -> `xai-oauth` returned `OD_PROXY_XAI_2_OK`

## Verdict: VALIDATED

### What worked

- Open Design's live Vercel proxy can call an HTTPS tunnel to a local bridge.
- The bridge can use Hermes' existing OAuth-backed providers without putting OAuth tokens in Vercel or browser storage.
- Both `openai-codex` and `xai-oauth` responded through the bridge.
- The bridge now emits OpenAI-compatible streaming frames (`data: { choices: ... }` + `[DONE]`), which Open Design's proxy successfully converts into its own app SSE events.

### What did not work / limitations

- The first version emitted app-style `event: delta` frames, which direct bridge tests passed but Open Design's proxy ignored. Fixed by switching bridge output to OpenAI-compatible SSE.
- This spike uses a subprocess per request, so latency is higher than a real provider adapter.
- Streaming is not true token-by-token streaming yet; Hermes returns a complete answer and the bridge sends it as one chunk.
- The bridge is a throwaway local process, not production-hardened.

### Recommendation for the real build

- Add a first-class "Local AI Bridge" provider option in Open Design docs/UI.
- Keep OAuth refresh/token custody inside Hermes/local bridge, not Vercel.
- Harden the bridge before regular use: random bridge secret, no prompt/token logs, better provider/model mapping, process reuse, true streaming if we integrate deeper than subprocess Hermes.
