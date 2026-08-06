# 9Router API Server

Standalone LLM API server that uses the 9router codebase as a library, without the dashboard UI.

## Why?

The full 9Router Next.js app includes:
- Dashboard UI (Monaco editor, Recharts, etc.)
- React SSR overhead
- ~300-500MB memory footprint

The API server provides the same LLM proxy endpoints in ~100-150MB.

## Requirements

- Node.js 20+
- 9Router main app (the API server imports from the 9router codebase)

## Setup

Both repos should live as siblings:

```
~/Documents/alvian/
├── 9router/             # 9router source
└── 9router-api/         # this repo
```

```bash
# Install dependencies
cd ~/Documents/alvian/9router-api
npm install

# Start the server
npm start
```

Or use PM2:

```bash
# Start with PM2
pm2 start ecosystem.config.js

# Check status
pm2 status 9r-api

# View logs
pm2 logs 9r-api

# Stop
pm2 delete 9r-api
```

## Configuration

`tsconfig.json` maps `@/` to `9router/src/` and `open-sse/*` to `9router/open-sse/*`:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["../9router/src/*"],
      "open-sse/*": ["../9router/open-sse/*"]
    }
  }
}
```

## Usage

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/translator/console-logs` | GET | Get buffered console logs |
| `/api/translator/console-logs` | DELETE | Clear console logs |
| `/api/translator/console-logs/stream` | GET | SSE stream of console logs |
| `/v1/chat/completions` | POST | OpenAI-compatible chat completions |

### Console Log Streaming

Connect to `/api/translator/console-logs/stream` via SSE:

```javascript
const es = new EventSource('http://localhost:20127/api/translator/console-logs/stream');

es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'init') {
    console.log('Buffered logs:', msg.logs);
  } else if (msg.type === 'line') {
    console.log('New log:', msg.line);
  } else if (msg.type === 'clear') {
    console.log('Logs cleared');
  }
};
```

## PM2 Commands

| Command | Description |
|---------|-------------|
| `pm2 start ecosystem.config.js` | Start API server |
| `pm2 stop 9r-api` | Stop API server |
| `pm2 restart 9r-api` | Restart API server |
| `pm2 logs 9r-api` | View logs |
| `pm2 delete 9r-api` | Remove from PM2 |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `20127` | Server port |
| `NINEROUTER_HOME` | - | Path to 9router repo |

## Architecture

```
9router-api/
├── package.json      # Dependencies (tsx, express, etc.)
├── tsconfig.json    # Path aliases for 9router imports
├── server.ts        # Express server with LLM handlers
├── ecosystem.config.js # PM2 config
└── src/
    └── exports.js    # Re-exports from 9router
```

The API server imports from 9router via tsconfig.json path aliases. Upstream updates are automatically reflected when 9router is updated.

## Troubleshooting

### Port already in use

```bash
# Check what's using the port
lsof -i :20127

# Use a different port
PORT=20130 npm start
```

### Module not found errors

Ensure `tsconfig.json` paths point to your 9router installation.

### Database errors

The API server shares the SQLite database with 9Router. Ensure 9Router is initialized before running the API server.

## License

Same as 9Router.
