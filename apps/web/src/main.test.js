import { beforeAll, describe, expect, it, vi } from 'vitest'

const tasks = [
  {
    id: 1,
    title: 'Ship board',
    description: 'Render the development board.',
    project: 'web',
    status: 'in_progress',
    priority: 'high',
    task_type: 'feature',
    acceptance_criteria: 'Tasks render.',
    objectives: 'Make the board useful.',
    requirements: 'Keep tasks structured.',
    decisions: 'Use dedicated SQLite columns.',
    relevant_files: 'apps/web/src/main.js',
    important_context: 'Keep services loopback-only.',
    work_completed: 'Card rendering works.',
    work_active: 'Updating tests.',
    work_blocked: 'None.',
    next_move: 'Review and commit.',
    created_at: '2026-11-09T10:00:00.000Z',
    updated_at: '2026-11-09T12:00:00.000Z'
  },
  {
    id: 2,
    title: 'Fix login',
    description: '',
    project: 'api',
    status: 'done',
    priority: 'urgent',
    task_type: 'bug',
    acceptance_criteria: '',
    created_at: '2026-11-08T10:00:00.000Z',
    updated_at: '2026-11-08T12:00:00.000Z'
  }
]

const taskDetail = {
  ...tasks[0],
  activity: [
    {
      id: 3,
      taskId: 1,
      action: 'updated',
      field: 'status',
      oldValue: 'todo',
      newValue: 'in_progress',
      createdAt: '2026-11-09T12:00:00.000Z'
    },
    {
      id: 2,
      taskId: 1,
      action: 'updated',
      field: 'priority',
      oldValue: 'medium',
      newValue: 'high',
      createdAt: '2026-11-09T11:00:00.000Z'
    },
    {
      id: 1,
      taskId: 1,
      action: 'created',
      createdAt: '2026-11-09T10:00:00.000Z'
    }
  ],
  aiRuns: [
    {
      id: 'job-2',
      taskId: 1,
      model: 'kaggle-3b',
      backend: 'kaggle-cli',
      state: 'error',
      phase: 'finished',
      title: 'Ship board',
      createdAt: '2026-11-09T12:30:00.000Z',
      startedAt: '2026-11-09T12:28:55.000Z',
      finishedAt: '2026-11-09T12:30:00.000Z',
      durationMs: 65_000,
      error: 'Kaggle runner failed.',
      status: 502,
      retryAfter: 30
    },
    {
      id: 'job-1',
      taskId: 1,
      model: 'local-0.5b',
      backend: 'http',
      state: 'done',
      phase: 'finished',
      title: 'Ship board',
      createdAt: '2026-11-09T11:30:00.000Z',
      startedAt: '2026-11-09T11:29:58.000Z',
      finishedAt: '2026-11-09T11:30:00.000Z',
      durationMs: 2000
    }
  ]
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

const models = [
  {
    id: 'local-0.5b',
    label: 'Qwen2.5-Coder 0.5B (local)',
    provider: 'local',
    execution: 'live',
    callable: true,
    autoSelect: true,
    billingCategory: 'free',
    requests: 3,
    failures: 1,
    lastDurationMs: 1500
  },
  {
    id: 'local-1.5b',
    label: 'Qwen2.5-Coder 1.5B (local)',
    provider: 'local',
    execution: 'live',
    callable: true,
    autoSelect: true,
    billingCategory: 'free'
  },
  {
    id: 'colab-3b',
    label: 'Qwen2.5-Coder 3B (Colab)',
    provider: 'colab',
    execution: 'live',
    callable: true,
    autoSelect: false,
    billingCategory: 'payg',
    notes: 'Calls a reusable Colab session through the colab CLI.',
    sessionState: 'absent',
    budget: {
      ok: true,
      limiters: [
        {
          policy: 'colab:requests:day:fixed',
          unit: 'requests',
          window: 'day',
          reset: 'fixed',
          limit: 10,
          used: 2,
          remaining: 8,
          ok: true,
          resetsInSeconds: 0,
          bucket: 1768435200000
        }
      ]
    }
  },
  {
    id: 'kaggle-3b',
    label: 'Qwen2.5-Coder 3B (Kaggle)',
    provider: 'kaggle',
    execution: 'batch',
    callable: true,
    autoSelect: false,
    billingCategory: 'subscription',
    notes: 'Submits a private Kaggle notebook through the kaggle CLI.',
    budget: {
      ok: false,
      cooldownSeconds: 45,
      limiters: [
        {
          policy: 'kaggle:requests:minute:rolling',
          unit: 'requests',
          window: 'minute',
          reset: 'rolling',
          limit: 3,
          used: 2,
          remaining: 1,
          ok: true,
          resetsInSeconds: 0
        },
        {
          policy: 'kaggle:requests:day:fixed',
          unit: 'requests',
          window: 'day',
          reset: 'fixed',
          limit: 5,
          used: 1,
          remaining: 4,
          ok: true,
          resetsInSeconds: 0,
          bucket: 1768435200000
        },
        {
          policy: 'kaggle:tokens:none:pool',
          unit: 'tokens',
          window: 'none',
          reset: 'pool',
          limit: 6000,
          used: 500,
          remaining: 5500,
          ok: true,
          resetsInSeconds: null,
          usageSupported: false
        }
      ]
    }
  }
]

const userFiles = [
  {
    id: 1,
    path: 'README.md',
    objective: 'Workspace guide',
    requirements: '',
    decisions: '',
    relevant_files: '',
    important_context: '',
    createdAt: '2026-11-09T10:00:00.000Z',
    updatedAt: '2026-11-09T10:00:00.000Z'
  },
  {
    id: 2,
    path: 'workspace',
    objective: '',
    requirements: '',
    decisions: '',
    relevant_files: '',
    important_context: '',
    createdAt: '2026-11-09T11:00:00.000Z',
    updatedAt: '2026-11-09T11:00:00.000Z'
  }
]

const folders = [
  {
    id: 1,
    path: 'apps',
    objective: 'Applications',
    createdAt: '2026-11-09T09:00:00.000Z',
    updatedAt: '2026-11-09T09:00:00.000Z'
  }
]

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path === '/api/tasks' || path.startsWith('/api/tasks?')) return jsonResponse(tasks)
    if (path === '/api/tasks/1') return jsonResponse(taskDetail)
    if (path === '/api/projects') return jsonResponse(['workspace', 'web', 'api'])
    if (path === '/api/models') return jsonResponse(models)
    if (path === '/api/files') return jsonResponse(userFiles)
    if (path === '/api/folders') return jsonResponse(folders)
    if (path === '/satellite/summary') {
      return jsonResponse({ total: 2, open: 1, completed: 1 })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))

  await import('./main.js')
})

describe('development board', () => {
  it('renders tasks from the API', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.task-item')).toHaveLength(2)
    })

    expect(document.querySelector('#task-count').textContent).toBe('2 shown')
    expect(document.querySelector('.task-item strong').textContent).toBe('Ship board')
  })

  it('renders structured planning sections on task cards', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.task-item')).toHaveLength(2)
    })

    const item = document.querySelector('.task-item')
    expect([...item.querySelectorAll('.task-notes summary')].map((node) => node.textContent))
      .toEqual([
        'Objectives',
        'Requirements',
        'Decisions',
        'Relevant files',
        'Important context',
        'Work completed',
        'Active work',
        'Blocked work',
        'Next move',
        'Acceptance criteria'
      ])
    expect([...item.querySelectorAll('.task-notes p')].map((node) => node.textContent))
      .toEqual([
        'Make the board useful.',
        'Keep tasks structured.',
        'Use dedicated SQLite columns.',
        'apps/web/src/main.js',
        'Keep services loopback-only.',
        'Card rendering works.',
        'Updating tests.',
        'None.',
        'Review and commit.',
        'Tasks render.'
      ])
  })

  it('shows the Python satellite summary', async () => {
    await vi.waitFor(() => {
      expect(document.querySelector('#satellite-summary').textContent)
        .toBe('2 total · 1 open · 1 completed')
    })
  })

  it('lists all four registered models', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.model-item')).toHaveLength(4)
    })

    expect(document.querySelector('#model-roster-status').textContent).toBe('4 registered')
    expect([...document.querySelectorAll('.model-state')].map((node) => node.textContent))
      .toEqual(['live', 'live', 'live', 'batch'])
    expect([...document.querySelectorAll('.model-item small')].map((node) => node.textContent))
      .toEqual([
        'local · live',
        'local · live',
        'Calls a reusable Colab session through the colab CLI. · explicit selection only',
        'Submits a private Kaggle notebook through the kaggle CLI. · explicit selection only'
      ])
  })

  it('shows each model billing category without hiding quota limits', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.model-billing')).toHaveLength(4)
    })

    expect([...document.querySelectorAll('.model-billing')].map((node) => node.textContent))
      .toEqual(['free', 'free', 'pay as you go', 'monthly subscription'])
  })

  it('shows budget, session, and usage details', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.model-meta')).toHaveLength(3)
    })

    expect([...document.querySelectorAll('.model-meta')].map((node) => node.textContent))
      .toEqual([
        '3 requests · 1 failed · last 2s',
        'budget 2/10 today · session absent',
        '2/3 requests per minute (rolling) · 1/5 requests per day (fixed) · 500/6000 tokens pool, usage unsupported · cooldown 45s'
      ])
  })

  it('offers callable models in the draft picker', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#draft-model option')).toHaveLength(5)
    })

    expect([...document.querySelectorAll('#draft-model option')].map((option) => [
      option.value,
      option.textContent
    ])).toEqual([
      ['', 'Auto (local models first)'],
      ['local-0.5b', 'Qwen2.5-Coder 0.5B (local)'],
      ['local-1.5b', 'Qwen2.5-Coder 1.5B (local)'],
      ['colab-3b', 'Qwen2.5-Coder 3B (Colab) — explicit'],
      ['kaggle-3b', 'Qwen2.5-Coder 3B (Kaggle) — explicit']
    ])
  })

  it('shows a task activity history on demand', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.task-item')).toHaveLength(2)
    })

    const item = document.querySelector('.task-item')
    const timestamps = [...item.querySelectorAll('.task-timestamps time')]
    expect(timestamps).toHaveLength(2)
    expect(timestamps[0].textContent).toMatch(/^Created /)
    expect(timestamps[1].textContent).toMatch(/^Updated /)

    item.querySelector('button[data-action="history"]').click()

    await vi.waitFor(() => {
      expect(item.querySelector('.task-activity')).not.toBeNull()
    })

    expect(item.querySelector('.task-activity summary').textContent).toBe('History (3)')
    expect([...item.querySelectorAll('.activity-message')].map((node) => node.textContent))
      .toEqual([
        'Status: Todo → In progress',
        'Priority: Medium → High',
        'Created'
      ])
    expect(item.querySelector('.task-ai-runs summary').textContent).toBe('AI runs (2)')
    expect([...item.querySelectorAll('.ai-run-message')].map((node) => node.textContent))
      .toEqual([
        'kaggle-3b · kaggle-cli · error (finished) · 1m 5s — Kaggle runner failed. (retry in 30s)',
        'local-0.5b · http · done (finished) · 2s'
      ])
  })

  it('cancels a running batch job from the draft button', async () => {
    const job = {
      id: 'job-1',
      state: 'running',
      phase: 'generating',
      model: 'kaggle-3b',
      elapsedMs: 65_000
    }
    let deleted = false

    vi.mocked(fetch).mockImplementation(async (path, options = {}) => {
      if (path === '/api/local-ai/status') {
        return jsonResponse({
          state: 'ready',
          models: [{
            id: 'kaggle-3b',
            label: 'Qwen2.5-Coder 3B (Kaggle)',
            execution: 'batch',
            state: 'ready'
          }]
        })
      }
      if (path === '/api/local-ai/jobs' && options.method === 'POST') {
        return jsonResponse({ id: 'job-1', state: 'queued', model: 'kaggle-3b' })
      }
      if (path === '/api/local-ai/jobs/job-1' && options.method === 'DELETE') {
        deleted = true
        return jsonResponse({ ...job, state: 'cancelled' })
      }
      if (path === '/api/local-ai/jobs/job-1') return jsonResponse(job)
      throw new Error(`Unexpected request: ${path}`)
    })

    const form = document.querySelector('#task-form')
    form.elements.title.value = 'Draft this task'
    document.querySelector('#draft-model').value = 'kaggle-3b'
    const button = document.querySelector('#draft-task')
    button.click()

    await vi.waitFor(() => {
      expect(document.querySelector('#task-status').textContent)
        .toContain('Batch job job-1 is generating · 1m 5s')
    })

    button.click()

    await vi.waitFor(() => {
      expect(deleted).toBe(true)
      expect(document.querySelector('#task-status').textContent)
        .toBe('Cancelled batch job job-1.')
    })
  })

  it('drafts an existing task with its id and refreshes linked runs', async () => {
    let draftBody
    vi.mocked(fetch).mockImplementation(async (path, options = {}) => {
      if (path === '/api/local-ai/status') {
        return jsonResponse({
          state: 'ready',
          models: [{
            id: 'local-0.5b',
            label: 'Qwen2.5-Coder 0.5B (local)',
            execution: 'live',
            state: 'ready'
          }]
        })
      }
      if (path === '/api/local-ai/refine-task' && options.method === 'POST') {
        draftBody = JSON.parse(options.body)
        return jsonResponse({
          description: 'Drafted description.',
          acceptance_criteria: 'Drafted criteria.'
        })
      }
      if (path === '/api/tasks/1') return jsonResponse(taskDetail)
      throw new Error(`Unexpected request: ${path}`)
    })

    document.querySelector('#draft-model').value = ''
    const item = document.querySelector('.task-item')
    item.querySelector('button[data-action="edit"]').click()
    const form = item.querySelector('.task-edit-form')
    expect(form.elements.objectives.value).toBe('Make the board useful.')
    expect(form.elements.important_context.value).toBe('Keep services loopback-only.')
    expect(form.elements.next_move.value).toBe('Review and commit.')
    form.querySelector('button[data-action="draft-edit"]').click()

    await vi.waitFor(() => {
      expect(form.elements.description.value).toBe('Drafted description.')
      expect(form.elements.acceptance_criteria.value).toBe('Drafted criteria.')
    })

    expect(draftBody.task_id).toBe(1)
    expect(draftBody.title).toBe('Ship board')
    expect(draftBody.objectives).toBe('Make the board useful.')
    expect(draftBody.relevant_files).toBe('apps/web/src/main.js')
    expect(draftBody.next_move).toBe('Review and commit.')
    expect(draftBody.priority).toBeUndefined()

    await vi.waitFor(() => {
      expect(item.querySelector('.task-ai-runs summary').textContent).toBe('AI runs (2)')
    })
    expect(item.querySelector('.ai-run-message').textContent).toContain('kaggle-3b')
  })
})

describe('user files and folders sections', () => {
  it('renders tracked user files with objectives', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.file-item')).toHaveLength(2)
    })

    expect(document.querySelector('#file-count').textContent).toBe('2 tracked')
    expect([...document.querySelectorAll('.file-item .file-path')].map((node) => node.textContent))
      .toEqual(['README.md', 'workspace'])
    expect([...document.querySelectorAll('.file-item .file-objective')].map((node) => node.textContent))
      .toEqual(['Workspace guide'])
    expect(document.querySelectorAll('.file-item button[data-action="edit-file"]')).toHaveLength(2)
  })

  it('renders tracked folders with objectives', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.folder-item')).toHaveLength(1)
    })

    expect(document.querySelector('#folder-count').textContent).toBe('1 tracked')
    expect(document.querySelector('.folder-item .folder-path').textContent).toBe('apps')
    expect(document.querySelector('.folder-item .folder-objective').textContent).toBe('Applications')
    expect(document.querySelectorAll('.folder-item button[data-action="edit-folder"]')).toHaveLength(1)
  })

  it('renders live quota and swarm worktree telemetry', async () => {
    vi.mocked(fetch).mockImplementation(async (path) => {
      if (path === '/api/models/providers') {
        return jsonResponse({
          ok: true,
          providers: [{
            provider: 'agy',
            ok: true,
            headroomPercent: 85,
            windows: { '5h': {}, weekly: {} },
            syncAudit: { status: 'fresh' }
          }]
        })
      }
      if (path === '/api/agents/runs?limit=5') {
        return jsonResponse({
          runs: [{
            id: 'run_123',
            status: 'completed',
            isolateWorktrees: true,
            goal: 'Verify telemetry panel'
          }]
        })
      }
      if (path === '/api/models') return jsonResponse([])
      if (path === '/api/tasks') return jsonResponse([])
      if (path === '/api/files') return jsonResponse([])
      if (path === '/api/folders') return jsonResponse([])
      return jsonResponse({})
    })

    document.body.innerHTML = '<div id="app"></div>'
    vi.resetModules()
    await import('./main.js')

    await vi.waitFor(() => {
      expect(document.querySelector('#telemetry-status').textContent).toBe('1 providers · 1 runs')
    })

    expect(document.querySelector('#quota-telemetry-list').textContent).toContain('agy')
    expect(document.querySelector('#quota-telemetry-list').textContent).toContain('85% headroom')
    expect(document.querySelector('#quota-telemetry-list').textContent).toContain('syncAudit: fresh')
    expect(document.querySelector('#swarm-telemetry-list').textContent).toContain('run_123')
    expect(document.querySelector('#swarm-telemetry-list').textContent).toContain('worktree')
  })

  it('refreshes telemetry on manual click and visibilitychange while skipping hidden ticks', async () => {
    vi.useFakeTimers()
    let providerCalls = 0
    vi.mocked(fetch).mockImplementation(async (path) => {
      if (path === '/api/models/providers') {
        providerCalls += 1
        return jsonResponse({
          ok: true,
          providers: [{
            provider: 'agy',
            ok: true,
            headroomPercent: providerCalls === 1 ? 85 : 80,
            windows: { '5h': {} },
            syncAudit: { status: 'fresh' }
          }]
        })
      }
      if (path === '/api/agents/runs?limit=5') {
        return jsonResponse({ runs: [] })
      }
      if (path === '/api/models') return jsonResponse([])
      if (path === '/api/tasks') return jsonResponse([])
      if (path === '/api/files') return jsonResponse([])
      if (path === '/api/folders') return jsonResponse([])
      return jsonResponse({})
    })

    document.body.innerHTML = '<div id="app"></div>'
    vi.resetModules()
    await import('./main.js')

    await vi.waitFor(() => {
      expect(providerCalls).toBe(1)
    })

    // Hidden tab should skip scheduled 15s interval ticks
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(providerCalls).toBe(1)

    // Returning to visible triggers an immediate refresh
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const callsBeforeVisible = providerCalls
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => {
      expect(providerCalls).toBeGreaterThan(callsBeforeVisible)
      expect(document.querySelector('#quota-telemetry-list').textContent).toContain('80% headroom')
    })

    // Manual Refresh button triggers a fetch
    const callsBeforeClick = providerCalls
    document.querySelector('#refresh-telemetry').click()
    await vi.waitFor(() => {
      expect(providerCalls).toBeGreaterThan(callsBeforeClick)
    })

    window.dispatchEvent(new Event('beforeunload'))
    vi.useRealTimers()
  })

  it('renders reviewer verdicts, merge status, and preserves open worktree diffs across refreshes', async () => {
    vi.mocked(fetch).mockImplementation(async (path) => {
      if (path === '/api/models/providers') {
        return jsonResponse({ ok: true, providers: [] })
      }
      if (path === '/api/agents/runs?limit=5') {
        return jsonResponse([{
          id: 'run_wt_1',
          status: 'completed',
          isolateWorktrees: true,
          reviewerVerdict: { status: 'approved', summary: 'All slices verified.' },
          worktreeMerge: { status: 'merged', branches: ['swarm/1/worker-1'], conflicts: [] },
          worktreeDiffs: [{ agent: 'worker-1', branch: 'swarm/1/worker-1', diff: '--- a/file.js\n+++ b/file.js' }]
        }])
      }
      if (path === '/api/models') return jsonResponse([])
      if (path === '/api/tasks') return jsonResponse([])
      if (path === '/api/files') return jsonResponse([])
      if (path === '/api/folders') return jsonResponse([])
      return jsonResponse({})
    })

    document.body.innerHTML = '<div id="app"></div>'
    vi.resetModules()
    await import('./main.js')

    await vi.waitFor(() => {
      expect(document.querySelector('#swarm-telemetry-list').textContent).toContain('reviewer: approved')
    })
    expect(document.querySelector('#swarm-telemetry-list').textContent).toContain('merge: merged')
    expect(document.querySelector('.telemetry-verdict').textContent).toBe('All slices verified.')

    const diffDetails = document.querySelector('.telemetry-diff')
    expect(diffDetails).not.toBeNull()
    diffDetails.open = true
    diffDetails.dispatchEvent(new Event('toggle'))

    document.querySelector('#refresh-telemetry').click()
    await vi.waitFor(() => {
      expect(document.querySelector('.telemetry-diff').open).toBe(true)
    })
    expect(document.querySelector('.telemetry-diff pre').textContent).toContain('+++ b/file.js')
    window.dispatchEvent(new Event('beforeunload'))
  })

  it('renders session handoffs in #swarm-telemetry-list and preserves open <details> state across refreshes', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })

    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search
      if (path === '/api/models/providers') {
        return jsonResponse({ providers: [{ id: 'agy', ok: true, headroomPercent: 90, windows: {} }] })
      }
      if (path === '/api/agents/runs?limit=5') {
        return jsonResponse({ runs: [] })
      }
      if (path === '/api/agents/handoffs?limit=5') {
        return jsonResponse([
          {
            id: 7,
            conversation_id: 'conv-handoff-7',
            task_id: 82,
            target_repo: 'multi-project-workspace',
            summary: 'Surfaced handoffs in telemetry',
            completed_commits: ['36d81ee'],
            next_actions: ['Add tests'],
            blockers: [],
          },
        ])
      }
      if (path === '/api/models') return jsonResponse([])
      if (path === '/api/tasks') return jsonResponse([])
      if (path === '/api/files') return jsonResponse([])
      if (path === '/api/folders') return jsonResponse([])
      return jsonResponse({})
    })

    document.body.innerHTML = '<div id="app"></div>'
    vi.resetModules()
    await import('./main.js')

    await vi.waitFor(() => {
      expect(document.querySelector('#telemetry-status').textContent).toBe('1 providers · 0 runs · 1 handoffs')
    })

    const listText = document.querySelector('#swarm-telemetry-list').textContent
    expect(listText).toContain('handoff:conv-handoff-7')
    expect(listText).toContain('multi-project-workspace')
    expect(listText).toContain('task #82')
    expect(listText).toContain('Surfaced handoffs in telemetry')

    const handoffDetails = document.querySelector('#swarm-telemetry-list .telemetry-diff')
    expect(handoffDetails).not.toBeNull()
    handoffDetails.open = true
    handoffDetails.dispatchEvent(new Event('toggle'))

    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => {
      expect(document.querySelector('#swarm-telemetry-list .telemetry-diff').open).toBe(true)
    })
    expect(document.querySelector('#swarm-telemetry-list .telemetry-diff pre').textContent).toContain('36d81ee')
    window.dispatchEvent(new Event('beforeunload'))
  })
})
