// Public API surface for external 9router-api consumer
// This file re-exports from the main 9router repo for use by the standalone API server
// Uses absolute paths resolved via tsconfig.json paths aliases

// LLM API handlers
export { handleChat } from '@/sse/handlers/chat.js';

// Database layer
export {
  getSettings,
  updateSettings,
  validateApiKey,
  getProviderConnections,
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
  getCombos,
  getComboByName,
  getApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
} from '@/lib/localDb.js';

// Auth
export { verifyDashboardAuthToken } from '@/lib/auth/dashboardSession.js';

// Console log buffer (for SSE streaming)
export {
  initConsoleLogCapture,
  getConsoleLogs,
  getConsoleEmitter,
  clearConsoleLogs,
} from '@/lib/consoleLogBuffer.js';

// Headroom proxy lifecycle
export {
  startHeadroomProxy,
  stopHeadroomProxy,
} from '@/lib/headroom/process.js';

// MCP gateway
export { handleJsonRpc } from '@/lib/mcp/gateway/handler.js';

export {
  DEFAULT_HEADROOM_URL,
  isLoopbackHeadroomUrl,
} from '@/lib/headroom/detect.js';

// open-sse core
export { getExecutor, hasSpecializedExecutor } from 'open-sse/index.js';
export { handleChatCore } from 'open-sse/handlers/chatCore.js';

// Token refresh
export { refreshTokenByProvider } from 'open-sse/services/tokenRefresh.js';
