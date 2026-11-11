// Objective: Expose the allowlisted local checks and run them in bounded subprocesses.
// Requirements: Never list or run commands outside the verifier allowlist; report structured results.
// Decisions: The verifier resolves lazily through the shared context so tests can inject one bound to a temporary repository.
// Relevant Files: apps/api/src/routes/verify.js, apps/api/src/localVerifier.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/verify.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { VerificationError } from '../localVerifier.js'

export function createVerifyRouter({ getVerifier }) {
  const router = Router()

  router.get('/api/verify', (_request, response) => {
    let verifierForRequest
    try {
      verifierForRequest = getVerifier()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for local checks.' })
    }
    return response.json({ checks: verifierForRequest.listChecks() })
  })

  router.post('/api/verify', async (request, response) => {
    let verifierForRequest
    try {
      verifierForRequest = getVerifier()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for local checks.' })
    }
    const requested = request.body?.checks
    if (requested !== undefined && (
      !Array.isArray(requested) ||
      requested.length === 0 ||
      requested.some((id) => typeof id !== 'string' || id.length === 0)
    )) {
      return response.status(400).json({ error: 'checks must be a non-empty array of check ids.' })
    }
    try {
      return response.json(await verifierForRequest.runChecks(requested))
    } catch (error) {
      if (error instanceof VerificationError) {
        return response.status(400).json({ error: error.message })
      }
      return response.status(500).json({ error: 'Could not run local checks.' })
    }
  })

  return router
}
