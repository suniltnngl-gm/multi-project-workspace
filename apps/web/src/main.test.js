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
    acceptance_criteria: 'Tasks render.'
  },
  {
    id: 2,
    title: 'Fix login',
    description: '',
    project: 'api',
    status: 'done',
    priority: 'urgent',
    task_type: 'bug',
    acceptance_criteria: ''
  }
]

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

const models = [
  { id: 'local-0.5b', label: 'Qwen2.5-Coder 0.5B (local)', provider: 'local', execution: 'live' },
  { id: 'local-1.5b', label: 'Qwen2.5-Coder 1.5B (local)', provider: 'local', execution: 'live' },
  { id: 'colab-3b', label: 'Qwen2.5-Coder 3B (Colab)', provider: 'colab', execution: 'manual' },
  { id: 'kaggle-3b', label: 'Qwen2.5-Coder 3B (Kaggle)', provider: 'kaggle', execution: 'batch' }
]

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path.startsWith('/api/tasks')) return jsonResponse(tasks)
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
      .toEqual(['live', 'live', 'manual', 'batch'])
  })
})
