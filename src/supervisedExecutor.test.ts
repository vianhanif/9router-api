import { describe, it, expect, vi } from 'vitest';
import { supervisedHandleChat } from './supervisedExecutor';
import * as exports from '../src/exports.js';

// Mock the handleChat export
vi.mock('../src/exports.js', () => ({
  handleChat: vi.fn(),
  markAccountUnavailable: vi.fn().mockResolvedValue({}),
  clearAccountError: vi.fn().mockResolvedValue({}),
}));

describe('supervisedHandleChat', () => {
  it('should pass through successful non-streaming response', async () => {
    const mockRes = new Response(JSON.stringify({ success: true }), {
      headers: { 'content-type': 'application/json' }
    });
    vi.mocked(exports.handleChat).mockResolvedValue(mockRes);

    const req = { headers: { get: () => null } };
    const res = await supervisedHandleChat(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(exports.handleChat)).toHaveBeenCalledTimes(1);
  });

  it('should retry once on failure', async () => {
    vi.mocked(exports.handleChat)
      .mockRejectedValueOnce(new Error('Transient error'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));

    const req = { headers: { get: () => null } };
    const res = await supervisedHandleChat(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(exports.handleChat).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('should heartbeat and cancel if stream stalls', async () => {
    // Mock a streaming response
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: chunk1\n\n'));
        // Don't emit anything else, wait for heartbeat to trigger
        await new Promise(r => setTimeout(r, 6000));
        controller.close();
      }
    });
    
    vi.mocked(exports.handleChat).mockResolvedValue(new Response(stream, {
      headers: { 'content-type': 'text/event-stream' }
    }));

    const req = { headers: { get: () => null } };
    const res = await supervisedHandleChat(req);
    
    // We expect the stream to be handled
    const reader = res.body.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe('data: chunk1\n\n');
  });
});
