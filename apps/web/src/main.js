import './style.css'
import { getProjectCards, workspaceSummary } from '../../../packages/shared/index.js'
import {
  buildTaskQuery,
  formatBusyMessage,
  priorities,
  statuses,
  taskTypes,
  waitForRetry
} from './lib.js'

const app = document.querySelector('#app')

app.innerHTML = `
  <main class="workspace-shell">
    <div class="workspace-banner">Workspace</div>
    <h1>${workspaceSummary.title}</h1>
    <p class="lead">A lightweight board for planning and tracking development work.</p>

    <section class="task-section" aria-labelledby="tasks-heading">
      <div class="section-heading">
        <div>
          <h2 id="tasks-heading">Development board</h2>
          <p>Capture work, define acceptance criteria, and track progress by project.</p>
        </div>
        <span id="task-count" class="task-count" aria-live="polite"></span>
      </div>

      <form id="task-form" class="task-form">
        <label class="field-title">
          <span>Task</span>
          <input name="title" maxlength="200" placeholder="e.g. Add password reset endpoint" required>
        </label>
        <label>
          <span>Project</span>
          <input name="project" list="project-options" maxlength="80" value="workspace" required>
          <datalist id="project-options"></datalist>
        </label>
        <label>
          <span>Type</span>
          <select name="task_type">
            <option value="feature">Feature</option>
            <option value="bug">Bug</option>
            <option value="chore">Chore</option>
            <option value="test">Test</option>
            <option value="docs">Docs</option>
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select name="priority">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label class="field-wide">
          <span>Description <small>(optional)</small></span>
          <textarea name="description" maxlength="2000" rows="2" placeholder="Implementation notes or context"></textarea>
        </label>
        <label class="field-wide">
          <span>Acceptance criteria <small>(optional)</small></span>
          <textarea name="acceptance_criteria" maxlength="2000" rows="2" placeholder="What must be true for this task to be done?"></textarea>
        </label>
        <button type="submit">Add task</button>
        <button id="draft-task" class="secondary-button field-wide" type="button">Draft brief with local AI</button>
      </form>

      <section class="models-section" aria-labelledby="models-heading">
        <div class="section-heading">
          <div>
            <h3 id="models-heading">Models</h3>
            <p>Local models run under resource limits; Colab and Kaggle use their CLIs or a configured HTTP endpoint.</p>
          </div>
          <span id="model-roster-status" class="satellite-status" aria-live="polite">Loading…</span>
        </div>
        <ul id="model-roster" class="model-list"></ul>
      </section>

      <form id="filter-form" class="filter-form" aria-label="Filter development tasks">
        <label class="search-field">
          <span class="sr-only">Search tasks</span>
          <input name="search" maxlength="200" placeholder="Search title, notes, criteria…">
        </label>
        <label>
          <span class="sr-only">Filter by project</span>
          <select name="project"><option value="">All projects</option></select>
        </label>
        <label>
          <span class="sr-only">Filter by status</span>
          <select name="status">
            <option value="">All statuses</option>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="done">Done</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Filter by priority</span>
          <select name="priority">
            <option value="">All priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Filter by type</span>
          <select name="task_type">
            <option value="">All types</option>
            <option value="feature">Feature</option>
            <option value="bug">Bug</option>
            <option value="chore">Chore</option>
            <option value="test">Test</option>
            <option value="docs">Docs</option>
          </select>
        </label>
        <button type="submit">Filter</button>
        <button id="clear-filters" class="secondary-button" type="button">Clear</button>
      </form>

      <p id="task-status" class="task-status" role="status" aria-live="polite"></p>
      <ul id="task-list" class="task-list"></ul>
    </section>

    <section class="satellite-section" aria-labelledby="satellite-heading">
      <div class="section-heading">
        <div>
          <h2 id="satellite-heading">Python satellite</h2>
          <p>Live task statistics from the shared SQLite database.</p>
        </div>
        <span id="satellite-status" class="satellite-status" aria-live="polite">Connecting…</span>
      </div>
      <div id="satellite-summary" class="satellite-summary"></div>
    </section>

    <section class="projects-section" aria-labelledby="projects-heading">
      <h2 id="projects-heading">Workspace projects</h2>
      <ul class="project-list">${getProjectCards()}</ul>
    </section>
  </main>
`

const taskForm = document.querySelector('#task-form')
const filterForm = document.querySelector('#filter-form')
const taskList = document.querySelector('#task-list')
const taskStatus = document.querySelector('#task-status')
const taskCount = document.querySelector('#task-count')
const projectOptions = document.querySelector('#project-options')
const draftTaskButton = document.querySelector('#draft-task')
const modelRoster = document.querySelector('#model-roster')
const modelRosterStatus = document.querySelector('#model-roster-status')
let tasks = []
let draftController = null

async function request(path, options) {
  const response = await fetch(path, options)
  if (response.status === 204) return null

  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error || 'The request failed.')
    error.status = response.status
    error.state = result.state
    error.retryAfter = result.retryAfter
    error.busyReasons = result.busyReasons
    throw error
  }
  return result
}

function showStatus(message, isError = false) {
  taskStatus.textContent = message
  taskStatus.classList.toggle('is-error', isError)
}

function renderModelRoster(models) {
  modelRoster.replaceChildren()
  for (const model of models) {
    const item = document.createElement('li')
    item.className = 'model-item'
    const name = document.createElement('strong')
    name.textContent = model.label
    const state = document.createElement('span')
    const stateName = model.state || model.execution
    state.className = `model-state model-state-${stateName}`
    state.textContent = stateName
    const note = document.createElement('small')
    const selection = model.autoSelect === false ? ' · explicit selection only' : ''
    note.textContent = (model.notes || `${model.provider} · ${model.execution}`) + selection
    item.append(name, state, note)
    modelRoster.append(item)
  }
}

async function loadModels() {
  try {
    const models = await request('/api/models')
    renderModelRoster(models)
    modelRosterStatus.textContent = `${models.length} registered`
    modelRosterStatus.classList.remove('is-error')
  } catch (error) {
    modelRosterStatus.textContent = `Unavailable: ${error.message}`
    modelRosterStatus.classList.add('is-error')
  }
}

function addField(form, labelText, name, { value = '', type = 'text', options, wide = false } = {}) {
  const label = document.createElement('label')
  if (wide) label.className = 'field-wide'
  const caption = document.createElement('span')
  caption.textContent = labelText
  label.append(caption)

  let control
  if (options) {
    control = document.createElement('select')
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement('option')
      option.value = optionValue
      option.textContent = optionLabel
      control.append(option)
    }
  } else if (type === 'textarea') {
    control = document.createElement('textarea')
    control.rows = 2
    control.maxLength = 2000
  } else {
    control = document.createElement('input')
    control.type = type
    control.maxLength = name === 'title' ? 200 : 80
    control.required = name === 'title' || name === 'project'
  }
  control.name = name
  control.value = value
  label.append(control)
  form.append(label)
  return control
}

function makeButton(text, className, action) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.dataset.action = action
  button.textContent = text
  return button
}

function createEditForm(task) {
  const form = document.createElement('form')
  form.className = 'task-edit-form'
  addField(form, 'Task', 'title', { value: task.title })
  addField(form, 'Project', 'project', { value: task.project })
  addField(form, 'Type', 'task_type', {
    value: task.task_type,
    options: taskTypes.map((type) => [type, type[0].toUpperCase() + type.slice(1)])
  })
  addField(form, 'Priority', 'priority', {
    value: task.priority,
    options: priorities.map((priority) => [priority, priority[0].toUpperCase() + priority.slice(1)])
  })
  addField(form, 'Description', 'description', { value: task.description, type: 'textarea', wide: true })
  addField(form, 'Acceptance criteria', 'acceptance_criteria', {
    value: task.acceptance_criteria,
    type: 'textarea',
    wide: true
  })
  const actions = document.createElement('div')
  actions.className = 'task-actions field-wide'
  const save = document.createElement('button')
  save.type = 'submit'
  save.textContent = 'Save changes'
  actions.append(save, makeButton('Cancel', 'secondary-button', 'cancel-edit'))
  form.append(actions)
  return form
}

function createTaskItem(task) {
  const item = document.createElement('li')
  item.className = `task-item status-${task.status}`
  item.dataset.taskId = task.id

  const heading = document.createElement('div')
  heading.className = 'task-heading'
  const content = document.createElement('div')
  content.className = 'task-content'
  const title = document.createElement('strong')
  title.textContent = task.title
  if (task.status === 'done') title.className = 'is-completed'
  content.append(title)
  if (task.description) {
    const description = document.createElement('p')
    description.textContent = task.description
    content.append(description)
  }

  const controls = document.createElement('div')
  controls.className = 'task-controls'
  const statusSelect = document.createElement('select')
  statusSelect.className = 'task-status-select'
  statusSelect.setAttribute('aria-label', `Status for ${task.title}`)
  for (const [value, label] of statuses) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    statusSelect.append(option)
  }
  statusSelect.value = task.status
  controls.append(statusSelect)

  const meta = document.createElement('div')
  meta.className = 'task-meta'
  for (const [value, className] of [
    [task.project, 'project-tag'],
    [task.task_type, 'type-tag'],
    [task.priority, `priority-tag priority-${task.priority}`]
  ]) {
    const tag = document.createElement('span')
    tag.className = className
    tag.textContent = value.replace('_', ' ')
    meta.append(tag)
  }

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  actions.append(
    makeButton('Edit', 'edit-task', 'edit'),
    makeButton('Delete', 'delete-task', 'delete')
  )

  heading.append(content, controls)
  item.append(heading, meta)
  if (task.acceptance_criteria) {
    const criteria = document.createElement('details')
    criteria.className = 'acceptance-criteria'
    const summary = document.createElement('summary')
    summary.textContent = 'Acceptance criteria'
    const text = document.createElement('p')
    text.textContent = task.acceptance_criteria
    criteria.append(summary, text)
    item.append(criteria)
  }
  item.append(actions)
  return item
}

function renderTasks() {
  taskList.replaceChildren()
  taskCount.textContent = `${tasks.length} shown`

  if (tasks.length === 0) {
    const emptyState = document.createElement('li')
    emptyState.className = 'empty-state'
    emptyState.textContent = 'No matching tasks. Add development work above or clear the filters.'
    taskList.append(emptyState)
    return
  }

  for (const task of tasks) taskList.append(createTaskItem(task))
}

async function loadProjects() {
  try {
    const projects = await request('/api/projects')
    projectOptions.replaceChildren()
    const filter = filterForm.elements.project
    const selectedProject = filter.value
    filter.replaceChildren(new Option('All projects', ''))

    for (const project of projects) {
      projectOptions.append(new Option(project, project))
      filter.append(new Option(project, project))
    }
    filter.value = selectedProject
  } catch (error) {
    showStatus(`Could not load projects: ${error.message}`, true)
  }
}

async function loadTasks() {
  try {
    const query = buildTaskQuery(new FormData(filterForm))
    tasks = await request(`/api/tasks?${query}`)
    renderTasks()
  } catch (error) {
    showStatus(`Could not load tasks: ${error.message}`, true)
  }
}

async function loadSatelliteSummary() {
  const status = document.querySelector('#satellite-status')
  const summary = document.querySelector('#satellite-summary')

  try {
    const data = await request('/satellite/summary')
    status.textContent = 'Connected'
    status.classList.remove('is-error')
    summary.textContent = `${data.total} total · ${data.open} open · ${data.completed} completed`
  } catch (error) {
    status.textContent = `Unavailable: ${error.message}`
    status.classList.add('is-error')
    summary.textContent = 'Start the workspace with ./workspace dev to connect the Python service.'
  }
}

taskForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const values = Object.fromEntries(new FormData(taskForm))

  try {
    await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values)
    })
    taskForm.reset()
    taskForm.elements.project.value = 'workspace'
    showStatus('Development task added.')
    await Promise.all([loadTasks(), loadProjects(), loadSatelliteSummary()])
    taskForm.elements.title.focus()
  } catch (error) {
    showStatus(`Could not add task: ${error.message}`, true)
  }
})

draftTaskButton.addEventListener('click', async () => {
  if (draftController) {
    draftController.abort()
    return
  }

  const title = taskForm.elements.title.value.trim()
  if (!title) {
    taskForm.elements.title.focus()
    showStatus('Enter a task title before asking the local model to draft it.')
    return
  }

  const controller = new AbortController()
  draftController = controller
  draftTaskButton.textContent = 'Cancel draft'
  draftTaskButton.setAttribute('aria-label', 'Cancel the waiting task draft')
  const signal = controller.signal

  try {
    let draft
    while (!signal.aborted) {
      const status = await request('/api/local-ai/status', { signal })
      if (status.models) {
        renderModelRoster(status.models)
        modelRosterStatus.textContent = status.state
        modelRosterStatus.classList.toggle('is-error', status.state === 'unavailable')
      }
      if (status.state === 'unavailable') {
        throw new Error(status.error || 'Local AI resource monitoring is unavailable.')
      }

      if (status.state === 'busy') {
        const retryAfter = status.retryAfter ?? 5
        showStatus(formatBusyMessage(status.busyReasons, retryAfter))
        await waitForRetry(retryAfter * 1000, signal)
        continue
      }

      showStatus('Local model is idle. Drafting a task brief…')
      try {
        draft = await request('/api/local-ai/refine-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(taskForm))),
          signal
        })
        break
      } catch (error) {
        if (error.state !== 'busy') throw error
        const retryAfter = error.retryAfter ?? 5
        showStatus(formatBusyMessage(error.busyReasons, retryAfter))
        await waitForRetry(retryAfter * 1000, signal)
      }
    }

    if (draft) {
      taskForm.elements.description.value = draft.description
      taskForm.elements.acceptance_criteria.value = draft.acceptance_criteria
      showStatus('Draft ready. Review it and edit as needed before adding the task.')
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      showStatus('Local AI draft cancelled.')
    } else {
      showStatus(`Could not draft task: ${error.message}`, true)
    }
  } finally {
    if (draftController === controller) {
      draftController = null
      draftTaskButton.textContent = 'Draft brief with local AI'
      draftTaskButton.removeAttribute('aria-label')
    }
  }
})

filterForm.addEventListener('submit', (event) => {
  event.preventDefault()
  loadTasks()
})

filterForm.addEventListener('change', (event) => {
  if (event.target.name !== 'search') loadTasks()
})

filterForm.elements.search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    loadTasks()
  }
})

document.querySelector('#clear-filters').addEventListener('click', () => {
  filterForm.reset()
  loadTasks()
})

taskList.addEventListener('change', async (event) => {
  if (!event.target.matches('.task-status-select')) return
  const item = event.target.closest('.task-item')
  const id = Number(item.dataset.taskId)

  try {
    await request(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: event.target.value })
    })
    showStatus('Task status updated.')
    await Promise.all([loadTasks(), loadSatelliteSummary()])
  } catch (error) {
    showStatus(`Could not update task: ${error.message}`, true)
    await loadTasks()
  }
})

taskList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]')
  if (!button) return
  const item = button.closest('.task-item')
  const id = Number(item.dataset.taskId)
  const task = tasks.find((candidate) => candidate.id === id)

  if (button.dataset.action === 'edit') {
    item.querySelector('.task-edit-form')?.remove()
    item.append(createEditForm(task))
    item.querySelector('.task-edit-form [name="title"]').focus()
    return
  }
  if (button.dataset.action === 'cancel-edit') {
    item.querySelector('.task-edit-form').remove()
    return
  }
  if (button.dataset.action !== 'delete') return

  try {
    await request(`/api/tasks/${id}`, { method: 'DELETE' })
    showStatus('Task deleted.')
    await Promise.all([loadTasks(), loadProjects(), loadSatelliteSummary()])
  } catch (error) {
    showStatus(`Could not delete task: ${error.message}`, true)
  }
})

taskList.addEventListener('submit', async (event) => {
  if (!event.target.matches('.task-edit-form')) return
  event.preventDefault()
  const item = event.target.closest('.task-item')
  const id = Number(item.dataset.taskId)
  const values = Object.fromEntries(new FormData(event.target))

  try {
    await request(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values)
    })
    showStatus('Task details saved.')
    await Promise.all([loadTasks(), loadProjects()])
  } catch (error) {
    showStatus(`Could not save task: ${error.message}`, true)
  }
})

loadTasks()
loadProjects()
loadSatelliteSummary()
loadModels()
