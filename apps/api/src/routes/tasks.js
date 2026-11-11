// Objective: Own the task board routes: listing, detail, projects, create, update, delete, and the linked task worktree lifecycle.
// Requirements: Validate task fields with the shared validators; record drafting provenance only at creation; self-heal stale worktree links.
// Decisions: Worktree row refresh comes from the git-worktrees group because it owns worktree registration; task deletion unlinks jobs through the shared job store so run history survives.
// Relevant Files: apps/api/src/routes/tasks.js, apps/api/src/routes/util.js, apps/api/src/routes/gitWorktrees.js, apps/api/src/app.js
// Important Context: User file. Route group for /api/tasks, /api/projects, and /api/tasks/:id/worktree.
// Work State: Completed: Extracted from app.js as task #45; Active: None; Blocked: None; Next Move: Maintain as needed.
import { Router } from 'express'
import { existsSync } from 'node:fs'
import {
  parseId,
  validateTaskInput,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_TYPES,
  MAX_PROJECT_LENGTH,
  TASK_TEXT_LIMITS
} from './util.js'
import { refreshGitWorktreeRows } from './gitWorktrees.js'

export function createTasksRouter({ database, jobStore, getTaskWorktrees }) {
  const router = Router()

  router.get('/api/tasks', (request, response) => {
    const filters = Object.fromEntries(
      ['project', 'status', 'priority', 'task_type', 'search']
        .map((field) => [field, request.query[field]])
        .filter(([, value]) => value !== undefined)
    )
    if (Object.values(filters).some((value) => typeof value !== 'string')) {
      return response.status(400).json({ error: 'Each task filter must have a single string value.' })
    }
    if (filters.project && filters.project.length > MAX_PROJECT_LENGTH) {
      return response.status(400).json({ error: `Project filter must be at most ${MAX_PROJECT_LENGTH} characters.` })
    }
    if (filters.status && !TASK_STATUSES.has(filters.status)) {
      return response.status(400).json({ error: `Status must be one of: ${[...TASK_STATUSES].join(', ')}.` })
    }
    if (filters.priority && !TASK_PRIORITIES.has(filters.priority)) {
      return response.status(400).json({ error: `Priority must be one of: ${[...TASK_PRIORITIES].join(', ')}.` })
    }
    if (filters.task_type && !TASK_TYPES.has(filters.task_type)) {
      return response.status(400).json({ error: `Task type must be one of: ${[...TASK_TYPES].join(', ')}.` })
    }
    if (filters.search && (typeof filters.search !== 'string' || filters.search.length > 200)) {
      return response.status(400).json({ error: 'Search must be at most 200 characters.' })
    }
    return response.json(database.listTasks(filters))
  })

  router.get('/api/tasks/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })

    let activityLimit = 50
    if (request.query.activity_limit !== undefined) {
      if (!/^[1-9]\d*$/.test(request.query.activity_limit)) {
        return response.status(400).json({ error: 'Activity limit must be a positive integer.' })
      }
      activityLimit = Number(request.query.activity_limit)
      if (!Number.isSafeInteger(activityLimit) || activityLimit > 200) {
        return response.status(400).json({ error: 'Activity limit must be at most 200.' })
      }
    }

    let aiLimit = 20
    if (request.query.ai_limit !== undefined) {
      if (!/^[1-9]\d*$/.test(request.query.ai_limit)) {
        return response.status(400).json({ error: 'AI run limit must be a positive integer.' })
      }
      aiLimit = Number(request.query.ai_limit)
      if (!Number.isSafeInteger(aiLimit) || aiLimit > 100) {
        return response.status(400).json({ error: 'AI run limit must be at most 100.' })
      }
    }

    const task = database.getTaskDetail(id, { activityLimit, aiLimit })
    if (!task) return response.status(404).json({ error: 'Task not found.' })
    return response.json(task)
  })

  router.get('/api/projects', (_request, response) => {
    response.json(['workspace', ...database.listProjects().filter((project) => project !== 'workspace')])
  })

  router.post('/api/tasks', (request, response) => {
    const validationError = validateTaskInput(request.body)
    if (validationError) return response.status(400).json({ error: validationError })

    // Drafting provenance: the AI job that produced this task can be recorded
    // at creation. It is validated before the insert so a bad reference
    // creates no orphan task.
    const sourceJobId = request.body.source_job_id !== undefined
      ? request.body.source_job_id.trim()
      : undefined
    if (sourceJobId !== undefined) {
      const sourceJob = database.getJob(sourceJobId)
      if (!sourceJob) {
        return response.status(404).json({ error: 'AI job not found.' })
      }
      if (sourceJob.taskId !== undefined && sourceJob.taskId !== null) {
        return response.status(409).json({ error: 'This AI job is already linked to a task.' })
      }
    }

    const task = database.createTask({
      title: request.body.title.trim(),
      description: (request.body.description ?? '').trim(),
      project: (request.body.project ?? 'workspace').trim(),
      status: request.body.status ?? 'todo',
      priority: request.body.priority ?? 'medium',
      task_type: request.body.task_type ?? 'feature',
      acceptance_criteria: (request.body.acceptance_criteria ?? '').trim(),
      objectives: (request.body.objectives ?? '').trim(),
      requirements: (request.body.requirements ?? '').trim(),
      decisions: (request.body.decisions ?? '').trim(),
      relevant_files: (request.body.relevant_files ?? '').trim(),
      important_context: (request.body.important_context ?? '').trim(),
      work_completed: (request.body.work_completed ?? '').trim(),
      work_active: (request.body.work_active ?? '').trim(),
      work_blocked: (request.body.work_blocked ?? '').trim(),
      next_move: (request.body.next_move ?? '').trim()
    })
    if (sourceJobId === undefined) return response.status(201).json(task)
    const drafted = database.setTaskOrigin(task.id, sourceJobId)
    jobStore.linkTask(sourceJobId, task.id)
    return response.status(201).json(drafted)
  })

  router.patch('/api/tasks/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })

    const validationError = validateTaskInput(request.body, { partial: true })
    if (validationError) return response.status(400).json({ error: validationError })

    const changes = { ...request.body }
    if (Object.hasOwn(changes, 'title')) changes.title = changes.title.trim()
    for (const field of [...Object.keys(TASK_TEXT_LIMITS), 'project']) {
      if (Object.hasOwn(changes, field)) changes[field] = changes[field].trim()
    }

    const task = database.updateTask(id, changes)
    if (!task) return response.status(404).json({ error: 'Task not found.' })
    return response.json(task)
  })

  router.delete('/api/tasks/:id', (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })
    if (!database.deleteTask(id)) return response.status(404).json({ error: 'Task not found.' })
    jobStore.unlinkTask(id)
    return response.status(204).end()
  })

  router.post('/api/tasks/:id/worktree', async (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })
    const task = database.getTask(id)
    if (!task) {
      return response.status(404).json({ error: 'Task not found.' })
    }
    let worktrees
    try {
      worktrees = getTaskWorktrees()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for task worktrees.' })
    }

    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body
      : {}
    const branch = typeof body.branch === 'string' && body.branch.trim()
      ? body.branch.trim()
      : undefined
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : undefined

    // A stale link (worktree removed by hand) self-heals: prune the
    // registration and relink instead of wedging the task.
    if (task.worktree_path) {
      if (existsSync(task.worktree_path)) {
        return response.status(409).json({
          error: 'This task already has a worktree linked.',
          worktreePath: task.worktree_path
        })
      }
      try {
        await worktrees.prune()
      } catch {
        // Pruning is best-effort; the link is stale either way.
      }
      database.deleteGitWorktree(task.worktree_path)
      database.unlinkTaskWorktree(id)
    }

    const location = worktrees.resolveWorktree({ taskId: id, title: task.title, name, branch })
    if (existsSync(location.path)) {
      return response.status(409).json({
        error: 'A worktree already exists at the task location; remove it first.',
        worktreePath: location.path
      })
    }
    try {
      await worktrees.create({ taskId: id, title: task.title, name, branch })
    } catch (error) {
      return response.status(500).json({ error: `Could not create the task worktree: ${error.message}` })
    }
    const linked = database.linkTaskWorktree(id, location.path)
    await refreshGitWorktreeRows(database, worktrees)
    response.status(201).json({
      task: linked,
      worktreePath: location.path,
      branch: location.branch
    })
  })

  router.delete('/api/tasks/:id/worktree', async (request, response) => {
    const id = parseId(request.params.id)
    if (id === null) return response.status(400).json({ error: 'Task ID must be a positive integer.' })
    const task = database.getTask(id)
    if (!task) {
      return response.status(404).json({ error: 'Task not found.' })
    }
    if (!task.worktree_path) {
      return response.status(404).json({ error: 'This task has no worktree linked.' })
    }
    let worktrees
    try {
      worktrees = getTaskWorktrees()
    } catch (error) {
      return response.status(500).json({ error: 'Could not resolve the repository for task worktrees.' })
    }
    const force = ['1', 'true', 'yes'].includes(String(request.query.force ?? '').toLowerCase())
    const path = task.worktree_path

    if (existsSync(path)) {
      try {
        await worktrees.remove({ path, force })
      } catch (error) {
        return response.status(409).json({
          error: force
            ? `Could not remove the task worktree: ${error.message}`
            : 'The worktree has uncommitted changes; pass ?force=1 to remove it anyway.',
          worktreePath: path
        })
      }
    } else {
      try {
        await worktrees.prune()
      } catch {
        // Pruning is best-effort.
      }
    }
    database.deleteGitWorktree(path)
    const unlinked = database.unlinkTaskWorktree(id)
    response.json({ task: unlinked, removedPath: path })
  })

  return router
}
