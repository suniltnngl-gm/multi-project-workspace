/**
 * Objective: Verify behavior and regressions for apps/web/vitest.config.js.
 * Requirements: Keep the implementation aligned with the documented API, tests, and repository conventions.
 * Decisions: Follow existing patterns and avoid changing unrelated behavior.
 * Relevant Files: apps/web/vitest.config.js
 * Important Context: User file. Vendor and transient artifacts are excluded from tracking.
 * Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.js'],
    include: ['src/**/*.test.js']
  }
})
