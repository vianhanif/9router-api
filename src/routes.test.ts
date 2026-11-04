import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('GET /v1/models (proxy to core 9router)', () => {
  const upstreamBody = {
    object: 'list',
    data: [
      { id: 'combo-fast', object: 'model', owned_by: '9router', kind: 'llm' },
      { id: 'gpt-4o', object: 'model', owned_by: 'openai', kind: 'llm' },
    ],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the upstream body through verbatim and forwards auth + raw querystring', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app)
      .get('/v1/models?limit=2')
      .set('Authorization', 'Bearer test-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(upstreamBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://9router:20128/v1/models?limit=2');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer test-key',
    });
  });

  it('propagates a 401 from core with core error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'API key required for remote API access' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const res = await request(app).get('/v1/models');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'API key required for remote API access' });
  });

  it('returns 503 when core is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const res = await request(app).get('/v1/models');

    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('service_unavailable');
  });

  it('preserves repeated capability params in the forwarded querystring', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await request(app).get('/v1/models?capability=vision&capability=tools');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://9router:20128/v1/models?capability=vision&capability=tools');
  });

  it('returns 503 (never the old static list) on a non-JSON upstream response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>bad gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ));

    const res = await request(app).get('/v1/models');

    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('service_unavailable');
    expect(JSON.stringify(res.body)).not.toContain('gpt-4o');
  });
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