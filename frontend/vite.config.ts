import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    define: { global: 'window' },
    server: {
      host: '0.0.0.0',
      proxy: {
        '/api': { target: env.VITE_PROXY_TARGET || 'http://localhost:8091', changeOrigin: true },
        '/auth': { target: env.VITE_PROXY_TARGET || 'http://localhost:8091', changeOrigin: true }
      }
    }
  };
});
