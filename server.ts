/**
 * 9Router API Server
 * 
 * Standalone LLM API server that uses the 9router codebase as a library.
 * Provides the same LLM proxy endpoints as the full Next.js app, without
 * the dashboard UI, for lighter resource usage.
 */

import express from 'express';
import { createRequire } from 'module';

// Initialize open-sse proxy fetch patch (must be first)
import '9router/open-sse/index.js';

// Import public API from 9router
import {
  handleChat,
  initConsoleLogCapture,
  getConsoleLogs,
  getConsoleEmitter,
  clearConsoleLogs,
} from './src/exports.js';

const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

const app = express();
const PORT = process.env.PORT || 20127;

// Initialize console log capture for SSE streaming
initConsoleLogCapture();

// Parse JSON bodies
app.use(express.json({ limit: '50mb' }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// === Health & Status ===

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'api-only',
    version: packageJson.version,
    timestamp: new Date().toISOString(),
  });
});

// === Console Log SSE Streaming ===

app.get('/api/translator/console-logs/stream', (req, res) => {
  const emitter = getConsoleEmitter();
  const bufferedLogs = getConsoleLogs();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send buffered logs on connect
  if (bufferedLogs.length > 0) {
    res.write(`data: ${JSON.stringify({ type: 'init', logs: bufferedLogs })}\n\n`);
  }

  // Stream new log lines
  const onLine = (line) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`);
    } catch {
      cleanup();
    }
  };

  const onLines = (lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return;
    try {
      res.write(`data: ${JSON.stringify({ type: 'lines', lines })}\n\n`);
    } catch {
      cleanup();
    }
  };

  const onClear = () => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'clear' })}\n\n`);
    } catch {
      cleanup();
    }
  };

  // Keepalive ping every 25s
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(keepalive);
    emitter.off('line', onLine);
    emitter.off('lines', onLines);
    emitter.off('clear', onClear);
  };

  emitter.on('line', onLine);
  emitter.on('lines', onLines);
  emitter.on('clear', onClear);

  // Cleanup on client disconnect
  req.on('close', cleanup);
});

// Clear console logs
app.delete('/api/translator/console-logs', (req, res) => {
  clearConsoleLogs();
  res.json({ success: true });
});

// Get buffered console logs
app.get('/api/translator/console-logs', (req, res) => {
  res.json({ success: true, logs: getConsoleLogs() });
});

// === LLM API Endpoints ===

// Wrapper to convert Express request to Web API Request format
const wrapExpressRequest = async (req, res, handler) => {
  try {
    // Create a Web API Request-like object from Express request
    const webRequest = {
      url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      headers: {
        get: (name) => req.get(name),
        entries: () => Object.entries(req.headers),
      },
      json: async () => req.body, // Express already parsed the body
    };

    const response = await handler(webRequest);
    
    // Handle response object
    if (response && typeof response.clone === 'function') {
      // It's a Response object (streaming or otherwise)
      const contentType = response.headers?.get?.('content-type') || 'application/json';
      const status = response.status || 200;
      
      res.status(status).setHeader('Content-Type', contentType);
      
      // Check if it's a streaming response
      if (contentType.includes('text/event-stream')) {
        // Stream the response body
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          } finally {
            res.end();
          }
        } else {
          res.end();
        }
      } else {
        // Non-streaming response - return as JSON or text
        const text = await response.text();
        try {
          res.json(JSON.parse(text));
        } catch {
          res.send(text);
        }
      }
    } else {
      // Fallback: return as-is
      res.json(response);
    }
  } catch (error) {
    console.error('[Server Error]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// OpenAI-compatible chat completions
app.post('/v1/chat/completions', (req, res) => wrapExpressRequest(req, res, handleChat));

// Also handle /v1/chat/completions with GET for CORS preflight
app.options('/v1/chat/completions', (req, res) => {
  res.sendStatus(200);
});

// OpenAI-compatible models list
app.get('/v1/models', async (req, res) => {
  // TODO: Wire up models handler from 9router
  res.json({
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', created: 1699899999, owned_by: 'openai' },
    ],
  });
});

// === Start Server ===

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[9Router API] Running on port ${PORT} (api-only mode)`);
});
