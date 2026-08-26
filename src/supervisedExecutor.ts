/**
 * SupervisedExecutor — Transparent auto-retry guard for LLM sessions.
 *
 * Wraps handleChat with:
 * - Two-phase watchdog (TTFT window before first chunk, stall window after)
 * - Client-abort propagation (stops pulling upstream on disconnect)
 * - Single transparent retry before bubbling 503 to client (TTFT-guard)
 * - Circuit-breaker: marks provider "fragile" after N consecutive stalls
 *
 * This lives in 9router-api as an enhancement layer; 9router core stays untouched.
 */

import { handleChat } from '../src/exports.js';
import { markAccountUnavailable, clearAccountError } from '../src/exports.js';

// Watchdog policy (env-injectable for tests). Two phases so slow-but-healthy
// streams are never cancelled: reasoning models can legitimately take >5s for
// the first token and stay silent for long stretches between tokens.
const DEFAULT_TTFT_MS = 60_000; // max wait for the FIRST transformed chunk
const DEFAULT_STALL_MS = 120_000; // max silence AFTER at least one chunk
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000; // handleChat() must resolve within this (TTFT hang guard)
const DEFAULT_FRAGILE_THRESHOLD = 3; // stalls before marking provider fragile
const STALL_COUNTER_TTL_MS = 5 * 60_000; // reset stall counts after 5 min

// Maximum transparent retries per request before bubbling error to client
const MAX_RETRIES = 1;

const cfg = () => ({
  ttftMs: Number(process.env.SUPERVISED_TTFT_MS || DEFAULT_TTFT_MS),
  stallMs: Number(process.env.SUPERVISED_STALL_MS || DEFAULT_STALL_MS),
  requestTimeoutMs: Number(process.env.SUPERVISED_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
  fragileThreshold: Number(process.env.SUPERVISED_FRAGILE_THRESHOLD || DEFAULT_FRAGILE_THRESHOLD),
});

/** In-memory stall counter per connectionId */
const stallCounters = new Map(); // connectionId -> { count: number, lastStall: number }

/**
 * Check if response body is a streaming SSE.
 */
function isStreamingResponse(response) {
  const ct = response.headers?.get?.('content-type') || '';
  return ct.includes('text/event-stream') || ct.includes('application/x-ndjson');
}

/**
 * Record a stall event for circuit-breaker tracking.
 */
function recordStall(connectionId: string | null) {
  if (!connectionId) return;
  const entry = stallCounters.get(connectionId) || { count: 0, lastStall: 0 };
  const now = Date.now();
  // Reset the counter if the previous stall is older than the TTL window.
  if (entry.lastStall && now - entry.lastStall > STALL_COUNTER_TTL_MS) entry.count = 0;
  entry.count++;
  entry.lastStall = now;
  stallCounters.set(connectionId, entry);

  if (entry.count >= cfg().fragileThreshold) {
    console.warn(`[SupervisedExecutor] Connection ${connectionId} flagged FRAGILE after ${entry.count} stalls`);
    // Mark as temporarily unavailable in 9router DB (async, non-blocking)
    markAccountUnavailable(connectionId, 60_000).catch(() => {});
  }
}

/**
 * Clear stall counter on successful response.
 */
function recordSuccess(connectionId: string | null) {
  if (!connectionId) return;
  const entry = stallCounters.get(connectionId);
  if (entry) {
    entry.count = 0;
    stallCounters.set(connectionId, entry);
  }
  // Clear any fragility flag on success
  clearAccountError(connectionId).catch(() => {});
}

/**
 * Enqueue a structured SSE error event before the stream terminates.
 * Matches OpenAI's error envelope so agents can classify the failure
 * (provider down vs timeout vs auth) instead of seeing a silent EOF.
 */
function sendSseError(controller, message: string, type = 'upstream_error', code = 'stream_interrupted') {
  try {
    const payload = JSON.stringify({ error: { message, type, code } });
    controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
  } catch {
    // Controller already closed/errored — nothing to surface.
  }
}

/**
 * Wrap a Web API Request with supervised heartbeat + retry logic.
 */
export async function supervisedHandleChat(webRequest) {
  let retryCount = 0;
  let connectionId: string | null = null;

  try {
    connectionId = webRequest.headers?.get?.('x-9router-connection-id') ||
                   webRequest.headers?.get?.('x-9router-account-id') ||
                   null;
  } catch {
    connectionId = null;
  }

  const execute = async () => {
    const response = await handleChat(webRequest);

    if (!isStreamingResponse(response)) {
      recordSuccess(connectionId);
      return response;
    }

    const body = response.body;
    if (!body) {
      recordSuccess(connectionId);
      return response;
    }

    const { ttftMs, stallMs } = cfg();
    const signal = (webRequest as { signal?: AbortSignal })?.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        reader = body.getReader();
        let chunksReceived = 0;
        let watchdogTimer: ReturnType<typeof setTimeout>;

        const clearWatchdog = () => clearTimeout(watchdogTimer);

        // Two-phase watchdog: the TTFT window applies before the first chunk
        // (reasoning models can take >5s to first token), the stall window
        // applies afterwards (long thinking silences are normal). Neither
        // fires on slow-but-healthy streams.
        const scheduleWatchdog = () => {
          clearWatchdog();
          const window = chunksReceived === 0 ? ttftMs : stallMs;
          watchdogTimer = setTimeout(() => {
            // Upstream stalled past the window. Surface a timeout error event
            // instead of silently cancelling, and record the stall so the
            // circuit breaker can eventually trip.
            sendSseError(controller, 'upstream stalled: no data within watchdog window', 'timeout', 'stream_timeout');
            recordStall(connectionId);
            reader?.cancel().catch(() => {});
          }, window);
        };

        const onAbort = () => {
          // Client disconnected: stop pulling upstream quietly (no error frame,
          // and definitely NOT a provider stall).
          clearWatchdog();
          reader?.cancel().catch(() => {});
        };

        scheduleWatchdog();

        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        try {
          let doneReceived = false;
          while (true) {
            let result;
            try {
              result = await reader.read();
            } catch (readErr) {
              if (signal?.aborted) break; // client abort — no error frame
              // Upstream read failed mid-stream: surface it rather than EOF.
              const msg = String((readErr as Error)?.message || readErr);
              sendSseError(controller, `upstream read failed: ${msg}`, 'upstream_error', 'stream_interrupted');
              break;
            }

            clearWatchdog();

            if (result.done) {
              // EOF reached: verify SSE termination signal was received.
              // SSE streams MUST end with "data: [DONE]" per the protocol.
              // Premature EOF indicates upstream corruption or network issue.
              // Skip the check on client abort — the stream is being cancelled
              // intentionally and should not produce an error frame.
              if (!doneReceived && !signal?.aborted) {
                sendSseError(controller, 'upstream stream ended without SSE termination signal', 'upstream_error', 'stream_interrupted');
              }
              break;
            }

            // Check if this chunk contains the SSE termination signal.
            const chunkStr = new TextDecoder().decode(result.value, { stream: true });
            if (chunkStr.includes('data: [DONE]')) {
              doneReceived = true;
            }

            chunksReceived++;
            controller.enqueue(result.value);

            if (chunksReceived === 1) recordSuccess(connectionId);
            scheduleWatchdog();
          }
        } catch (err) {
          if (!signal?.aborted) {
            // Unexpected pump error: surface a structured error event.
            const msg = String((err as Error)?.message || err);
            sendSseError(controller, `upstream stream error: ${msg}`, 'upstream_error', 'stream_interrupted');
          }
        } finally {
          clearWatchdog();
          if (signal) signal.removeEventListener('abort', onAbort);
          try { controller.close(); } catch {}
        }
      },
      cancel() {
        // Server-side reader.cancel() (e.g. client abort propagation) stops
        // the upstream pump immediately.
        reader?.cancel().catch(() => {});
      },
    });

    return new Response(stream, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers.entries()), 'X-9Router-Supervised': 'true' },
    });
  };

  // TTFT hang guard: handleChat() must resolve within the request timeout, or
  // we surface a structured retryable timeout instead of hanging forever when
  // the upstream accepts the connection but never produces a response.
  const executeWithTimeout = async () => {
    const { requestTimeoutMs } = cfg();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutError = Object.assign(
      new Error('upstream did not respond within the request timeout'),
      { status: 503, code: 'ttft_timeout', type: 'timeout' },
    ) as Error & { status: number; code: string; type: string };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(timeoutError);
      }, requestTimeoutMs);
    });

    const execPromise = execute();
    // If the request times out, cancel a late-arriving response so the
    // upstream stream is not left draining after we already errored.
    execPromise.then((res) => {
      if (timedOut) res?.body?.cancel?.().catch?.(() => {});
    }).catch(() => {});

    try {
      const result = await Promise.race([execPromise, timeoutPromise]);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  };

  try {
    return await executeWithTimeout();
  } catch (firstError) {
    if (!isRetryableError(firstError) || retryCount >= MAX_RETRIES) {
      recordStall(connectionId);
      throw firstError;
    }
    retryCount++;
    console.warn(`[SupervisedExecutor] Retryable error: ${(firstError as Error).message}, retrying...`);
    try {
      return await executeWithTimeout();
    } catch (retryError) {
      recordStall(connectionId);
      throw retryError;
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = String((error as Error).message || '').toLowerCase();
  const name = String((error as Error).name || '').toLowerCase();
  const code = String((error as any)?.code || '').toLowerCase();
  if (msg.includes('unauthorized') || msg.includes('forbidden')) return false;
  return true;
}
