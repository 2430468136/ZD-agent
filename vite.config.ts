import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const uiPort = Number(process.env.ZHIDIAN_UI_PORT ?? 5173)
const apiPort = Number(process.env.ZHIDIAN_API_PORT ?? 8787)
const uiHosts = new Set([`localhost:${uiPort}`, `127.0.0.1:${uiPort}`])

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            const host = incoming.headers.host ?? ''
            if (!incoming.headers.origin && incoming.headers['sec-fetch-site'] === 'same-origin' && uiHosts.has(host)) {
              outgoing.setHeader('origin', `http://${host}`)
            }
          })
        },
      },
    },
  },
})
