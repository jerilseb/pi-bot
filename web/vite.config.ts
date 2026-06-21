import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// In dev you open the app and Vite proxies /ws and /api to the Node backend on
// 8787 (HMR for the UI). In production there is no Vite server: `vite build`
// produces web/dist which the Node server serves on 8787.
//
// When WEB_TLS_HOST is set in the repo-root .env and matching certs exist in
// certs/<host>.{crt,key}, the dev server is served over HTTPS at
// https://<host>:5173 — a secure origin, which iOS Safari requires for
// microphone capture and Web Push. Otherwise it falls back to plain HTTP.
export default defineConfig(({ mode }) => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const env = loadEnv(mode, repoRoot, '');
  const tlsHost = env.WEB_TLS_HOST?.trim();

  const certDir = fileURLToPath(new URL('../certs/', import.meta.url));
  const certPath = tlsHost ? `${certDir}${tlsHost}.crt` : '';
  const keyPath = tlsHost ? `${certDir}${tlsHost}.key` : '';
  const httpsEnabled = Boolean(tlsHost) && existsSync(certPath) && existsSync(keyPath);

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      ...(tlsHost ? { allowedHosts: [tlsHost] } : {}),
      ...(httpsEnabled ? { https: { cert: readFileSync(certPath), key: readFileSync(keyPath) } } : {}),
      proxy: {
        '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
        '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
