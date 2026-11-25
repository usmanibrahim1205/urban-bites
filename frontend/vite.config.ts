import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { config, port } from '../backend/src/config.ts'

const proxyHost = config.backendHost === '0.0.0.0' ? '127.0.0.1' : config.backendHost
const backendUrl = `http://${proxyHost}:${config.backendPort}`

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: {
    host: process.env.FRONTEND_HOST ?? '127.0.0.1',
    port: port('FRONTEND_PORT', 5173),
    strictPort: true,
    fs: {
      allow: [import.meta.dirname, resolve(import.meta.dirname, '../node_modules')],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '*.sqlite*', '*.db', '*.db-*'],
    },
    proxy: {
      '/api': { target: backendUrl, changeOrigin: false },
      '/socket.io': {
        target: backendUrl,
        changeOrigin: false,
        ws: true,
      },
    },
  },
})
