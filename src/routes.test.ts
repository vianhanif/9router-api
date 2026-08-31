import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock the supervised executor so POST /v1/responses never attempts a real
// provider call. We only want to verify the Express route wiring: that the
// endpoint exists and returns an HTTP status other than 404.
vi.mock('./supervisedExecutor.js', () => ({
  supervisedHandleChat: vi.fn(),
}));

import { app } from '../server.js';
import { supervisedHandleChat } from './supervisedExecutor.js';

const mockedSupervisedHandleChat = vi.mocked(supervisedHandleChat);

beforeEach(() => {
  mockedSupervisedHandleChat.mockReset();
});

describe('POST /v1/responses', () => {
  it('responds with an HTTP status other than 404 when the handler runs (200/400/401)', async () => {
    const mockResponse = new Response(
      JSON.stringify({ id: 'resp_test', object: 'response', output: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    mockedSupervisedHandleChat.mockResolvedValue(mockResponse as any);

    const res = await request(app)
      .post('/v1/responses')
      .set('Content-Type', 'application/json')
      .send({
        model: 'gpt-4o',
        input: 'ping',
      });

    // The endpoint must be routed — never a 404.
    expect([200, 400, 401]).toContain(res.status);
    expect(mockedSupervisedHandleChat).toHaveBeenCalledTimes(1);
  });

  it('surfaces auth failures as 400/401 (still not 404)', async () => {
    const err = Object.assign(new Error('no active credentials for provider'), {
      status: 401,
    });
    mockedSupervisedHandleChat.mockRejectedValue(err as any);

    const res = await request(app)
      .post('/v1/responses')
      .set('Content-Type', 'application/json')
      .send({ model: 'gpt-4o', input: 'ping' });

    expect([400, 401]).toContain(res.status);
    expect(res.status).not.toBe(404);
    expect(mockedSupervisedHandleChat).toHaveBeenCalledTimes(1);
  });
});