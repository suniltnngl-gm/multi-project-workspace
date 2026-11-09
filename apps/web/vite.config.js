/**
 * Objective: Implement and maintain apps/web/vite.config.js.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: apps/web/vite.config.js
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
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
