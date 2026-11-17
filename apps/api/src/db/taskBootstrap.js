import { randomUUID } from 'node:crypto'

const PROJECT = 'curl-ai-bridge'

export function createTaskBootstrapStore(connection, { clock = () => Date.now(), expectedGeneration = 9 } = {}) {
  const register = connection.transaction((input) => {
    const { task, authorizationRef, idempotencyKey } = input ?? {}
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('task_bootstrap_task_required')
    if (task.id !== undefined && task.id !== null) throw new Error('task_bootstrap_existing_id_rejected')
    if (task.project !== PROJECT) throw new Error('task_bootstrap_wrong_project')
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.trim().length > 200) throw new Error('task_bootstrap_title_invalid')
    if (typeof authorizationRef !== 'string' || !authorizationRef.trim()) throw new Error('task_bootstrap_authorization_ref_required')
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('task_bootstrap_idempotency_key_required')
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('task_bootstrap_expected_generation_invalid')

    if (connection.prepare('SELECT 1 FROM project_writer_bootstrap_events WHERE idempotency_key = ?').get(idempotencyKey)) {
      throw new Error('task_bootstrap_idempotency_replay')
    }
    const state = connection.prepare('SELECT fencing_generation FROM project_writer_lease_state WHERE project_id = ?').get(PROJECT)
    if (!state) throw new Error('task_bootstrap_lease_state_missing')
    if (state.fencing_generation !== expectedGeneration) throw new Error('task_bootstrap_generation_mismatch')
    const maxTaskId = connection.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM tasks').get().id
    const sequence = connection.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get()?.seq ?? 0
    if (Math.max(maxTaskId, sequence) + 1 !== 146) throw new Error('task_bootstrap_next_task_id_mismatch')
    if (connection.prepare("SELECT 1 FROM project_writer_leases WHERE project_id = ? AND status = 'active' LIMIT 1").get(PROJECT)) {
      throw new Error('task_bootstrap_active_lease_exists')
    }

    const now = new Date(clock()).toISOString()
    const nextGeneration = expectedGeneration + 1
    const title = task.title.trim()
    const description = typeof task.description === 'string' ? task.description : ''
    const priority = typeof task.priority === 'string' ? task.priority : 'medium'
    const taskType = typeof task.task_type === 'string' ? task.task_type : 'feature'
    const result = connection.prepare(`
      INSERT INTO tasks (
        title, description, completed, project, status, priority, task_type,
        acceptance_criteria, objectives, requirements, decisions, relevant_files,
        important_context, work_completed, work_active, work_blocked, next_move,
        created_at, updated_at
      ) VALUES (?, ?, 0, ?, 'blocked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title, description, PROJECT, priority, taskType,
      task.acceptance_criteria ?? '', task.objectives ?? '', task.requirements ?? '',
      task.decisions ?? '', task.relevant_files ?? '', task.important_context ?? '',
      task.work_completed ?? '', task.work_active ?? '', task.work_blocked ?? '',
      task.next_move ?? '', now, now
    )
    const taskId = Number(result.lastInsertRowid)
    connection.prepare('INSERT INTO task_events (task_id, action, created_at) VALUES (?, ?, ?)').run(taskId, 'created', now)
    const eventId = randomUUID()
    connection.prepare(`
      INSERT INTO project_writer_bootstrap_events
        (event_id, project_id, task_id, fencing_generation, authorization_ref, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, PROJECT, taskId, nextGeneration, authorizationRef.trim(), idempotencyKey, now)
    connection.prepare(`
      UPDATE project_writer_lease_state
      SET fencing_generation = ?, current_lease_id = NULL, updated_at = ?
      WHERE project_id = ? AND fencing_generation = ?
    `).run(nextGeneration, now, PROJECT, expectedGeneration)
    if (connection.prepare('SELECT changes() AS count').get().count !== 1) throw new Error('task_bootstrap_generation_claim_failed')
    return { taskId, projectId: PROJECT, status: 'blocked', completed: 0, fencingGeneration: nextGeneration, currentLeaseId: null, eventId, idempotencyKey }
  })

  function registerTaskBootstrap(input) {
    const { task, authorizationRef, idempotencyKey } = input ?? {}
    if (!task || task.project !== PROJECT) throw new Error('task_bootstrap_wrong_project')
    if (task.id !== undefined && task.id !== null) throw new Error('task_bootstrap_existing_id_rejected')
    if (typeof authorizationRef !== 'string' || !authorizationRef.trim()) throw new Error('task_bootstrap_authorization_ref_required')
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('task_bootstrap_idempotency_key_required')
    if (connection.prepare('SELECT 1 FROM project_writer_bootstrap_events WHERE idempotency_key = ?').get(idempotencyKey)) {
      throw new Error('task_bootstrap_idempotency_replay')
    }
    const state = connection.prepare('SELECT fencing_generation FROM project_writer_lease_state WHERE project_id = ?').get(PROJECT)
    if (!state || state.fencing_generation !== expectedGeneration) throw new Error('task_bootstrap_generation_mismatch')
    const maxTaskId = connection.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM tasks').get().id
    const sequence = connection.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get()?.seq ?? 0
    if (Math.max(maxTaskId, sequence) + 1 !== 146) throw new Error('task_bootstrap_next_task_id_mismatch')
    if (connection.prepare("SELECT 1 FROM project_writer_leases WHERE project_id = ? AND status = 'active' LIMIT 1").get(PROJECT)) {
      throw new Error('task_bootstrap_active_lease_exists')
    }
    return register.immediate(input)
  }

  return { registerTaskBootstrap }
}

export function createCurrentGenerationTaskBootstrapStore(connection, { clock = () => Date.now() } = {}) {
  const register = connection.transaction((input) => {
    const { task, authorizationRef, idempotencyKey, expectedGeneration } = input ?? {}
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('task_bootstrap_task_required')
    if (task.id !== undefined && task.id !== null) throw new Error('task_bootstrap_existing_id_rejected')
    if (task.project !== PROJECT) throw new Error('task_bootstrap_wrong_project')
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.trim().length > 200) throw new Error('task_bootstrap_title_invalid')
    if (typeof authorizationRef !== 'string' || !authorizationRef.trim()) throw new Error('task_bootstrap_authorization_ref_required')
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('task_bootstrap_idempotency_key_required')
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('task_bootstrap_expected_generation_invalid')

    const existingEvent = connection.prepare(
      'SELECT event_id, task_id, fencing_generation FROM project_writer_bootstrap_events WHERE idempotency_key = ?'
    ).get(idempotencyKey)
    if (existingEvent) {
      return {
        taskId: existingEvent.task_id,
        projectId: PROJECT,
        status: 'blocked',
        completed: 0,
        fencingGeneration: existingEvent.fencing_generation,
        currentLeaseId: null,
        eventId: existingEvent.event_id,
        idempotencyKey,
        replayed: true
      }
    }

    const state = connection.prepare('SELECT fencing_generation FROM project_writer_lease_state WHERE project_id = ?').get(PROJECT)
    if (!state) throw new Error('task_bootstrap_lease_state_missing')
    if (state.fencing_generation !== expectedGeneration) throw new Error('task_bootstrap_generation_mismatch')
    if (connection.prepare("SELECT 1 FROM project_writer_leases WHERE project_id = ? AND status = 'active' LIMIT 1").get(PROJECT)) {
      throw new Error('task_bootstrap_active_lease_exists')
    }

    const now = new Date(clock()).toISOString()
    const title = task.title.trim()
    const description = typeof task.description === 'string' ? task.description : ''
    const priority = typeof task.priority === 'string' ? task.priority : 'medium'
    const taskType = typeof task.task_type === 'string' ? task.task_type : 'feature'
    const result = connection.prepare(`
      INSERT INTO tasks (
        title, description, completed, project, status, priority, task_type,
        acceptance_criteria, objectives, requirements, decisions, relevant_files,
        important_context, work_completed, work_active, work_blocked, next_move,
        created_at, updated_at
      ) VALUES (?, ?, 0, ?, 'blocked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title, description, PROJECT, priority, taskType,
      task.acceptance_criteria ?? '', task.objectives ?? '', task.requirements ?? '',
      task.decisions ?? '', task.relevant_files ?? '', task.important_context ?? '',
      task.work_completed ?? '', task.work_active ?? '', task.work_blocked ?? '',
      task.next_move ?? '', now, now
    )
    const taskId = Number(result.lastInsertRowid)
    connection.prepare('INSERT INTO task_events (task_id, action, created_at) VALUES (?, ?, ?)').run(taskId, 'created', now)
    const eventId = randomUUID()
    connection.prepare(`
      INSERT INTO project_writer_bootstrap_events
        (event_id, project_id, task_id, fencing_generation, authorization_ref, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, PROJECT, taskId, state.fencing_generation, authorizationRef.trim(), idempotencyKey, now)

    return {
      taskId,
      projectId: PROJECT,
      status: 'blocked',
      completed: 0,
      fencingGeneration: state.fencing_generation,
      currentLeaseId: null,
      eventId,
      idempotencyKey,
      replayed: false
    }
  })

  return {
    registerTaskAtCurrentGeneration(input) {
      return register(input)
    }
  }
}
