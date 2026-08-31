import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../9router/src'),
      'open-sse': path.resolve(__dirname, '../9router/open-sse'),
      '9router': path.resolve(__dirname, '../9router'),
    },
  },
});
