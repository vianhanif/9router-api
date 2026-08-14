## Summary
Implement transparent auto-retry mechanism in `open-sse/executors/base.js` to prevent abrupt session termination during LLM failures.

## JIRA
N/A

## Testing
- Simulate upstream stall (empty responses)
- Verify `AbortController` heartbeat logic
- Confirm single-retry behavior before bubbling 503 to client

## Risks / Limitations
- Retries only happen if request has not yet streamed data to the client (TTFT-guard).
- Increases latency by at most one full provider response time on retry.

## Before vs After
### Before
- `handleSingleModelChat` returns a raw promise.
- If upstream connection drops or stalls, the entire request hangs until a TCP timeout, causing client session death.
- No auto-retry logic for transient streaming stalls.

### After
- `handleSingleModelChat` wrapped in a Supervised Executor.
- `AbortController` monitors heartbeat for 5s.
- Stalls trigger a transparent retry (within the `handleComboChat` retry logic), keeping the session alive.
