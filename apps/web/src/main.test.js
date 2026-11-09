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
    autoSelect: true
  },
  {
    id: 'colab-3b',
    label: 'Qwen2.5-Coder 3B (Colab)',
    provider: 'colab',
    execution: 'live',
    callable: true,
    autoSelect: false,
    notes: 'Calls a reusable Colab session through the colab CLI.',
    sessionState: 'absent',
    budget: { used: 2, limit: 10 }
  },
  {
    id: 'kaggle-3b',
    label: 'Qwen2.5-Coder 3B (Kaggle)',
    provider: 'kaggle',
    execution: 'batch',
    callable: true,
    autoSelect: false,
    notes: 'Submits a private Kaggle notebook through the kaggle CLI.',
    budget: { used: 1, limit: 5 }
  }
]

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path === '/api/tasks' || path.startsWith('/api/tasks?')) return jsonResponse(tasks)
    if (path === '/api/tasks/1') return jsonResponse(taskDetail)
    if (path === '/api/projects') return jsonResponse(['workspace', 'web', 'api'])
    if (path === '/api/models') return jsonResponse(models)
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

  it('shows budget, session, and usage details', async () => {
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.model-meta')).toHaveLength(3)
    })

    expect([...document.querySelectorAll('.model-meta')].map((node) => node.textContent))
      .toEqual([
        '3 requests · 1 failed · last 2s',
        'budget 2/10 today · session absent',
        'budget 1/5 today'
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
})
