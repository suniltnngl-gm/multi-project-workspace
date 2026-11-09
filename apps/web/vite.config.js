import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/satellite': {
        target: 'http://localhost:3002',
        rewrite: (path) => path.replace(/^\/satellite/, '')
      }
    }
  }
})
