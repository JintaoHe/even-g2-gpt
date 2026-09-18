import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'EVEN_');
  const target = env.EVEN_DEV_BACKEND_ORIGIN?.trim() || 'ws://127.0.0.1:3001';
  const backend = new URL(target);
  const local = backend.hostname === '127.0.0.1' || backend.hostname === 'localhost';
  if (!['ws:', 'wss:'].includes(backend.protocol)
    || backend.username || backend.password || backend.pathname !== '/'
    || backend.search || backend.hash || (!local && backend.protocol !== 'wss:')) {
    throw new Error('EVEN_DEV_BACKEND_ORIGIN must be a WebSocket origin; non-local targets require wss://');
  }
  const requestOrigin = `${backend.protocol === 'wss:' ? 'https:' : 'http:'}//${backend.host}`;
  const packagedOrigin = mode === 'production'
    ? (env.EVEN_HUB_BACKEND_ORIGIN?.trim() || 'wss://calendar.eveng2assistant.com')
    : '';
  if (packagedOrigin) {
    const packaged = new URL(packagedOrigin);
    if (packaged.protocol !== 'wss:' || packaged.username || packaged.password
      || packaged.pathname !== '/' || packaged.search || packaged.hash) {
      throw new Error('EVEN_HUB_BACKEND_ORIGIN must be a bare wss:// origin');
    }
  }

  return {
    base: './',
    define: { __EVEN_BACKEND_ORIGIN__: JSON.stringify(packagedOrigin) },
    server: { host: '127.0.0.1', port: 5173, strictPort: true,
      // Development-only proxy. It never exposes the backend listener or enters the production bundle.
      proxy: { '/ws/conversation': { target: backend.origin, ws: true, changeOrigin: true,
        configure(proxy) { proxy.on('proxyReqWs', request => request.setHeader('Origin', requestOrigin)); }
      } }
    },
    build: { target: 'es2022', sourcemap: false }
  };
});
