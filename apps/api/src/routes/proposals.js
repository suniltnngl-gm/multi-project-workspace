// Objective: Own the task proposal routes: listing, detail, and the approve, reject, and rollback decisions.
// Requirements: Listing filters by status and validates it; every decision maps the store's error objects verbatim so state conflicts surface as 409 and unknown ids as 404; approve returns the created task alongside the proposal.
// Decisions: A read-and-decide group because proposals are created only by the AI improve route, never by direct POST; the three decision endpoints share one handler because they differ only in the store method they call; the status whitelist mirrors the tasks list so filters stay strict.
// Relevant Files: apps/api/src/routes/proposals.js, apps/api/src/db/taskProposals.js, apps/api/src/routes/aiDrafts.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/proposals; the approval gate behind task #41.
// Work State: Completed: Added as task #41; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { parseId } from './util.js'

const PROPOSAL_STATUSES = new Set(['proposed', 'approved', 'rejected', 'rolled_back'])

export function createProposalsRouter({ database }) {
  const router = Router()

  router.get('/api/proposals', (request, response) => {
    const status = request.query.status
    if (status !== undefined && (typeof status !== 'string' || !PROPOSAL_STATUSES.has(status))) {
      return response.status(400).json({
        error: `Status must be one of: ${[...PROPOSAL_STATUSES].join(', ')}.`
      })
    }
    return response.json(database.listTaskProposals({ ...(status ? { status } : {}) }))
  })

  router.get('/api/proposals/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Proposal ID must be a positive integer.' })
    const proposal = database.getTaskProposal(id)
    if (!proposal) return response.status(404).json({ error: 'Task proposal not found.' })
    return response.json(proposal)
  })

  const decide = (method) => (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Proposal ID must be a positive integer.' })
    const result = database[method](id)
    if (result.error) return response.status(result.error.status).json(result.error.body)
    return response.json(result)
  }

  router.post('/api/proposals/:id/approve', decide('approveTaskProposal'))
  router.post('/api/proposals/:id/reject', decide('rejectTaskProposal'))
  router.post('/api/proposals/:id/rollback', decide('rollbackTaskProposal'))

  return router
}
