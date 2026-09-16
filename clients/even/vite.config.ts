import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    // Local-only proxy preserves the backend's existing same-origin checks.
    proxy: { '/ws/conversation': { target: 'ws://127.0.0.1:3001', ws: true, changeOrigin: true,
      configure(proxy) { proxy.on('proxyReqWs', request => request.setHeader('Origin', 'http://127.0.0.1:3001')); }
    } }
  },
  build: { target: 'es2022' }
});
