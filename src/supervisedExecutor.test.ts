import { describe, it, expect, vi, afterEach } from 'vitest';
import { supervisedHandleChat } from './supervisedExecutor';
import * as exports from '../src/exports.js';

// Mock the handleChat export
vi.mock('../src/exports.js', () => ({
  handleChat: vi.fn(),
  markAccountUnavailable: vi.fn().mockResolvedValue({}),
  clearAccountError: vi.fn().mockResolvedValue({}),
}));

const readAll = async (res: Response) => {
  const reader = res.body!.getReader();
  const all: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    all.push(new TextDecoder().decode(value));
  }
  return all.join('');
};

const streamingResponse = (stream: ReadableStream) =>
  new Response(stream, { headers: { 'content-type': 'text/event-stream' } });

const plainReq = () => ({ headers: { get: () => null } });
const connReq = (id: string) => ({
  headers: { get: (name: string) => (name === 'x-9router-connection-id' ? id : null) },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('supervisedHandleChat', () => {
  it('should pass through successful non-streaming response', async () => {
    const mockRes = new Response(JSON.stringify({ success: true }), {
      headers: { 'content-type': 'application/json' }
    });
    vi.mocked(exports.handleChat).mockResolvedValue(mockRes);

    const res = await supervisedHandleChat(plainReq());
    expect(res.status).toBe(200);
    expect(vi.mocked(exports.handleChat)).toHaveBeenCalledTimes(1);
  });

  it('should retry once on failure', async () => {
    vi.mocked(exports.handleChat)
      .mockRejectedValueOnce(new Error('Transient error'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));

    const res = await supervisedHandleChat(plainReq());
    expect(res.status).toBe(200);
    expect(vi.mocked(exports.handleChat).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('should emit SSE error event when upstream read fails mid-stream', async () => {
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: chunk1\n\n'));
        await new Promise(r => setTimeout(r, 50));
        controller.error(new Error('connection reset by provider'));
      },
    });

    vi.mocked(exports.handleChat).mockResolvedValue(streamingResponse(stream));

    const res = await supervisedHandleChat(plainReq());
    const joined = await readAll(res);
    expect(joined).toContain('data: chunk1');
    expect(joined).toContain('stream_interrupted');
  });

  it('should emit SSE error event when upstream stalls (watchdog timeout)', async () => {
    vi.stubEnv('SUPERVISED_STALL_MS', '100');
    vi.stubEnv('SUPERVISED_TTFT_MS', '100');

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: chunk1\n\n'));
        // No further data: the stall watchdog should fire after 100ms.
        await new Promise(r => setTimeout(r, 300));
      },
    });

    vi.mocked(exports.handleChat).mockResolvedValue(streamingResponse(stream));

    const res = await supervisedHandleChat(plainReq());
    const joined = await readAll(res);
    expect(joined).toContain('data: chunk1');
    expect(joined).toContain('stream_timeout');
  }, 15_000);

  it('should NOT cancel a slow-but-healthy stream with TTFT > old 5s heartbeat', async () => {
    // Regression test: the old 5s heartbeat cancelled healthy generations with
    // slow first tokens (observed TTFT 6165ms on opencode/big-pickle). With the
    // two-phase watchdog (TTFT window 60s), a 6.2s silent first-token wait must
    // NOT produce a stream_timeout.
    vi.stubEnv('SUPERVISED_TTFT_MS', '60000');
    vi.stubEnv('SUPERVISED_STALL_MS', '60000');

    const stream = new ReadableStream({
      async start(controller) {
        await new Promise(r => setTimeout(r, 6200));
        controller.enqueue(new TextEncoder().encode('data: chunk1\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    vi.mocked(exports.handleChat).mockResolvedValue(streamingResponse(stream));

    const res = await supervisedHandleChat(plainReq());
    const joined = await readAll(res);
    expect(joined).toContain('data: chunk1');
    expect(joined).not.toContain('stream_timeout');
    expect(joined).not.toContain('stream_interrupted');
  }, 15_000);

  it('should reject with ttft_timeout when handleChat never resolves (TTFT hang guard)', async () => {
    vi.stubEnv('SUPERVISED_REQUEST_TIMEOUT_MS', '100');
    vi.mocked(exports.handleChat).mockImplementation(() => new Promise(() => {}));

    await expect(supervisedHandleChat(plainReq())).rejects.toMatchObject({
      code: 'ttft_timeout',
      status: 503,
    });
    // Retry logic ran: the hang was attempted twice before bubbling up.
    expect(vi.mocked(exports.handleChat).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('should stop quietly on client abort (no error frame, no stall)', async () => {
    const abortController = new AbortController();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: chunk1\n\n'));
        await new Promise(r => setTimeout(r, 300));
        controller.close();
      },
    });

    vi.mocked(exports.handleChat).mockResolvedValue(streamingResponse(stream));

    const res = await supervisedHandleChat({
      headers: { get: () => null },
      signal: abortController.signal,
    });

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe('data: chunk1\n\n');

    abortController.abort();

    const rest: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(new TextDecoder().decode(value));
    }
    const joined = rest.join('');
    expect(joined).not.toContain('stream_timeout');
    expect(joined).not.toContain('stream_interrupted');
  });

  it('should record a stall (and trip the circuit breaker) on watchdog timeout', async () => {
    vi.stubEnv('SUPERVISED_STALL_MS', '100');
    vi.stubEnv('SUPERVISED_TTFT_MS', '100');
    vi.stubEnv('SUPERVISED_FRAGILE_THRESHOLD', '1');

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: chunk1\n\n'));
        await new Promise(r => setTimeout(r, 300));
      },
    });

    vi.mocked(exports.handleChat).mockResolvedValue(streamingResponse(stream));

    const res = await supervisedHandleChat(connReq('conn-1'));
    const joined = await readAll(res);
    expect(joined).toContain('stream_timeout');
    expect(exports.markAccountUnavailable).toHaveBeenCalledWith('conn-1', 60_000);
  }, 15_000);

  it('should emit SSE error event when upstream stream ends prematurely (no [DONE] signal)', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: chunk1\n\n'));
        controller.close(); // Closed without "data: [DONE]"
      },
    });

    vi.mocked(exports.handleChat).mockResolvedValue(streamingResponse(stream));

    const res = await supervisedHandleChat(plainReq());
    const joined = await readAll(res);
    expect(joined).toContain('data: chunk1');
    expect(joined).toContain('stream_interrupted');
    expect(joined).toContain('upstream stream ended without SSE termination signal');
  });
});
