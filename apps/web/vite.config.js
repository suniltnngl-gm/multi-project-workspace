import { defineConfig } from 'vite'

/* global process */
const apiPort = process.env.PORT || process.env.API_PORT || 3001
const pythonPort = process.env.PYTHON_PORT || 3002
const webPort = process.env.WEB_PORT || 5173

export default defineConfig({
  server: {
    port: Number(webPort),
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/satellite': {
        target: `http://localhost:${pythonPort}`,
        rewrite: (path) => path.replace(/^\/satellite/, '')
      }
    }
  }
})
