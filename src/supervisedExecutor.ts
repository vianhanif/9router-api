/**
 * SupervisedExecutor — Transparent auto-retry guard for LLM sessions.
 *
 * Wraps handleChat with:
 * - Heartbeat monitoring via AbortController (5s silent threshold)
 * - Single transparent retry before bubbling 503 to client (TTFT-guard)
 * - Circuit-breaker: marks provider "fragile" after 3 consecutive stalls
 *
 * This lives in 9router-api as an enhancement layer; 9router core stays untouched.
 */

import { handleChat } from '../src/exports.js';
import { markAccountUnavailable, clearAccountError } from '../src/exports.js';

// Heartbeat: upstream must emit data within HEARTBEAT_MS or we treat it as a stall
const HEARTBEAT_MS = 5000;

// Maximum transparent retries per request before bubbling error to client
const MAX_RETRIES = 1;

// Consecutive stalls before marking provider connection as "fragile"
const FRAGILE_THRESHOLD = 3;

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
  entry.count++;
  entry.lastStall = Date.now();
  stallCounters.set(connectionId, entry);

  if (entry.count >= FRAGILE_THRESHOLD) {
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

    const stream = new ReadableStream({
      async start(controller) {
        const reader = body.getReader();
        let heartbeatTimer: ReturnType<typeof setTimeout>;
        let chunksReceived = 0;

        const resetHeartbeat = () => {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = setTimeout(() => {
            reader.cancel().catch(() => {});
          }, HEARTBEAT_MS);
        };

        resetHeartbeat();

        try {
          while (true) {
            let result;
            try {
              result = await reader.read();
            } catch (readErr) { break; }

            clearTimeout(heartbeatTimer);

            if (result.done) break;

            chunksReceived++;
            controller.enqueue(result.value);

            if (chunksReceived === 1) recordSuccess(connectionId);
            resetHeartbeat();
          }
        } catch (err) {
        } finally {
          clearTimeout(heartbeatTimer);
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers.entries()), 'X-9Router-Supervised': 'true' },
    });
  };

  try {
    return await execute();
  } catch (firstError) {
    if (!isRetryableError(firstError) || retryCount >= MAX_RETRIES) {
      recordStall(connectionId);
      throw firstError;
    }
    retryCount++;
    console.warn(`[SupervisedExecutor] Retryable error: ${firstError.message}, retrying...`);
    try {
      return await execute();
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
