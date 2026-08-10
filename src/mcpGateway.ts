/**
 * MCP Gateway — Streamable HTTP endpoint handlers.
 *
 * Exposes the 9router MCP gateway (`handleJsonRpc`) on the Express server.
 * A single POST handles a single JSON-RPC request; notifications return 202.
 * No SSE transport, no session headers — stateless per POST.
 */

import type { Request, Response } from 'express';
import { handleJsonRpc } from './exports.js';

const STDIO_KEY = '__9routerGatewayStdio';

// Minimal Web-Request-like shim: handler only reads headers.get(name) + url.
function buildRequestShim(req: Request) {
  return {
    url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    headers: {
      get: (name: string) => req.get(name) ?? null,
    },
  };
}

export async function postMcpGateway(req: Request, res: Response) {
  try {
    const body = req.body;
    // express.json() leaves body undefined for empty/wrong Content-Type.
    if (typeof body !== 'object' || body === null) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      });
      return;
    }
    const out = await handleJsonRpc(buildRequestShim(req), body);
    if (out.kind === 'notification') {
      res.status(202).end();
      return;
    }
    res.status(out.status || 200).json(out.body);
  } catch (error) {
    console.error('[mcp-gw] handler error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'internal error' },
    });
  }
}

export function getMcpGateway(_req: Request, res: Response) {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'POST JSON-RPC requests' },
    });
}

/**
 * Kill any stdio MCP child processes spawned by the gateway.
 * Entries live in globalThis.__9routerGatewayStdio (Map<instanceId, StdioEntry>).
 * Defensive: never throws.
 */
export function shutdownStdioChildren() {
  try {
    const store = (globalThis as Record<string, unknown>)[STDIO_KEY];
    if (!(store instanceof Map)) return;
    for (const entry of store.values()) {
      try {
        const proc = (entry as { proc?: { killed?: boolean; exitCode?: number | null; kill?: (signal: string) => void } })?.proc;
        if (proc && !proc.killed && proc.exitCode === null) {
          proc.kill?.('SIGTERM');
        }
      } catch {
        // ignore per-entry failures
      }
    }
    store.clear();
  } catch (error) {
    console.error('[mcp-gw] stdio shutdown failed:', (error as Error).message);
  }
}
