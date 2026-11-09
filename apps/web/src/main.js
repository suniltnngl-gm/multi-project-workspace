import './style.css'
import { getProjectCards, workspaceSummary } from '../../../packages/shared/index.js'
import {
  buildDraftInput,
  buildTaskQuery,
  formatAiRun,
  formatBusyMessage,
  formatJobProgress,
  formatModelMeta,
  formatRelativeTime,
  formatTaskActivity,
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
        <label>
          <span>Draft model</span>
          <select id="draft-model">
            <option value="">Auto</option>
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
        <details class="task-planning field-wide">
          <summary>Objectives, requirements &amp; context <small>(optional)</small></summary>
          <div class="task-planning-fields">
            <label>
              <span>Objectives</span>
              <textarea name="objectives" maxlength="2000" rows="2" placeholder="What outcome should this task achieve?"></textarea>
            </label>
            <label>
              <span>Requirements</span>
              <textarea name="requirements" maxlength="2000" rows="2" placeholder="Constraints, behaviours, or inputs that must be preserved"></textarea>
            </label>
            <label>
              <span>Decisions</span>
              <textarea name="decisions" maxlength="2000" rows="2" placeholder="Choices already made and why"></textarea>
            </label>
            <label>
              <span>Relevant files</span>
              <textarea name="relevant_files" maxlength="2000" rows="2" placeholder="Files, modules, or commands worth inspecting"></textarea>
            </label>
            <label>
              <span>Important context</span>
              <textarea name="important_context" maxlength="2000" rows="2" placeholder="Background, caveats, or constraints for whoever picks this up"></textarea>
            </label>
          </div>
        </details>
        <details class="task-planning field-wide">
          <summary>Work state <small>(optional)</small></summary>
          <div class="task-planning-fields">
            <label>
              <span>Work completed</span>
              <textarea name="work_completed" maxlength="2000" rows="2" placeholder="What is already finished or verified"></textarea>
            </label>
            <label>
              <span>Active work</span>
              <textarea name="work_active" maxlength="2000" rows="2" placeholder="What is currently in progress"></textarea>
            </label>
            <label>
              <span>Blocked work</span>
              <textarea name="work_blocked" maxlength="2000" rows="2" placeholder="What is stalled and why"></textarea>
            </label>
            <label>
              <span>Next move</span>
              <textarea name="next_move" maxlength="2000" rows="2" placeholder="The immediate next action"></textarea>
            </label>
          </div>
        </details>
        <button type="submit">Add task</button>
        <button id="draft-task" class="secondary-button field-wide" type="button">Draft brief with AI</button>
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
          <input name="search" maxlength="200" placeholder="Search title, notes, planning…">
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

    <section class="files-section" aria-labelledby="files-heading">
      <div class="section-heading">
        <div>
          <h2 id="files-heading">User files</h2>
          <p>Centralized metadata for tracked user files; vendor and transient paths are excluded.</p>
        </div>
        <span id="file-count" class="task-count" aria-live="polite"></span>
      </div>
      <button id="scan-files" class="secondary-button" type="button">Scan user files</button>
      <p id="file-status" class="task-status" role="status" aria-live="polite"></p>
      <ul id="file-list" class="file-list"></ul>
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
const fileList = document.querySelector('#file-list')
const fileCount = document.querySelector('#file-count')
const fileStatus = document.querySelector('#file-status')
const scanFilesButton = document.querySelector('#scan-files')
const taskCount = document.querySelector('#task-count')
const projectOptions = document.querySelector('#project-options')
const draftTaskButton = document.querySelector('#draft-task')
const draftModel = document.querySelector('#draft-model')
const modelRoster = document.querySelector('#model-roster')
const modelRosterStatus = document.querySelector('#model-roster-status')
let tasks = []
let draftController = null
let activeJobId = null

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

    const metaText = formatModelMeta(model)
    if (metaText) {
      const meta = document.createElement('span')
      meta.className = 'model-meta'
      meta.textContent = metaText
      item.append(meta)
    }
    modelRoster.append(item)
  }
}

function populateDraftModels(models) {
  const selected = draftModel.value
  draftModel.replaceChildren(new Option('Auto (local models first)', ''))
  for (const model of models) {
    if (model.callable === false) continue
    const suffix = model.autoSelect === false ? ' — explicit' : ''
    draftModel.append(new Option(`${model.label}${suffix}`, model.id))
  }
  if ([...draftModel.options].some((option) => option.value === selected)) {
    draftModel.value = selected
  }
}

async function loadModels() {
  try {
    const models = await request('/api/models')
    renderModelRoster(models)
    populateDraftModels(models)
    modelRosterStatus.textContent = `${models.length} registered`
    modelRosterStatus.classList.remove('is-error')
  } catch (error) {
    modelRosterStatus.textContent = `Unavailable: ${error.message}`
    modelRosterStatus.classList.add('is-error')
  }
}

function addField(form, labelText, name, { value = '', type = 'text', options, wide = false } = {}, container = form) {
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
  container.append(label)
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
  const planning = document.createElement('details')
  planning.className = 'task-planning field-wide'
  const planningSummary = document.createElement('summary')
  planningSummary.textContent = 'Objectives, requirements & context'
  const planningFields = document.createElement('div')
  planningFields.className = 'task-planning-fields'
  planning.append(planningSummary, planningFields)
  form.append(planning)
  for (const [labelText, name] of [
    ['Objectives', 'objectives'],
    ['Requirements', 'requirements'],
    ['Decisions', 'decisions'],
    ['Relevant files', 'relevant_files'],
    ['Important context', 'important_context']
  ]) {
    addField(form, labelText, name, {
      value: task[name] ?? '',
      type: 'textarea',
      wide: true
    }, planningFields)
  }

  const workState = document.createElement('details')
  workState.className = 'task-planning field-wide'
  const workStateSummary = document.createElement('summary')
  workStateSummary.textContent = 'Work state'
  const workStateFields = document.createElement('div')
  workStateFields.className = 'task-planning-fields'
  workState.append(workStateSummary, workStateFields)
  form.append(workState)
  for (const [labelText, name] of [
    ['Work completed', 'work_completed'],
    ['Active work', 'work_active'],
    ['Blocked work', 'work_blocked'],
    ['Next move', 'next_move']
  ]) {
    addField(form, labelText, name, {
      value: task[name] ?? '',
      type: 'textarea',
      wide: true
    }, workStateFields)
  }

  const actions = document.createElement('div')
  actions.className = 'task-actions field-wide'
  const save = document.createElement('button')
  save.type = 'submit'
  save.textContent = 'Save changes'
  actions.append(
    makeButton('Draft with AI', 'secondary-button', 'draft-edit'),
    save,
    makeButton('Cancel', 'secondary-button', 'cancel-edit')
  )
  form.append(actions)
  return form
}

const TASK_CARD_SECTIONS = [
  ['objectives', 'Objectives'],
  ['requirements', 'Requirements'],
  ['decisions', 'Decisions'],
  ['relevant_files', 'Relevant files'],
  ['important_context', 'Important context'],
  ['work_completed', 'Work completed'],
  ['work_active', 'Active work'],
  ['work_blocked', 'Blocked work'],
  ['next_move', 'Next move'],
  ['acceptance_criteria', 'Acceptance criteria']
]

function appendTaskSection(item, label, value) {
  const details = document.createElement('details')
  details.className = 'task-notes'
  const summary = document.createElement('summary')
  summary.textContent = label
  const text = document.createElement('p')
  text.textContent = value
  details.append(summary, text)
  item.append(details)
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

  const timestamps = document.createElement('div')
  timestamps.className = 'task-timestamps'
  if (task.created_at) {
    const created = document.createElement('time')
    created.dateTime = task.created_at
    created.title = task.created_at
    created.textContent = `Created ${formatRelativeTime(task.created_at)}`
    timestamps.append(created)
  }
  if (task.updated_at) {
    const updated = document.createElement('time')
    updated.dateTime = task.updated_at
    updated.title = task.updated_at
    updated.textContent = `Updated ${formatRelativeTime(task.updated_at)}`
    timestamps.append(updated)
  }

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  actions.append(
    makeButton('History', 'history-task', 'history'),
    makeButton('Edit', 'edit-task', 'edit'),
    makeButton('Delete', 'delete-task', 'delete')
  )

  heading.append(content, controls)
  item.append(heading, meta)
  if (timestamps.childElementCount > 0) item.append(timestamps)
  for (const [field, label] of TASK_CARD_SECTIONS) {
    if (task[field]) appendTaskSection(item, label, task[field])
  }
  item.append(actions)
  return item
}

function renderTaskActivity(task) {
  const details = document.createElement('details')
  details.className = 'task-activity'
  details.open = true

  const summary = document.createElement('summary')
  const count = task.activity?.length ?? 0
  summary.textContent = `History (${count})`
  details.append(summary)

  if (count === 0) {
    const empty = document.createElement('p')
    empty.className = 'activity-empty'
    empty.textContent = 'No recorded activity yet.'
    details.append(empty)
    return details
  }

  const list = document.createElement('ol')
  list.className = 'activity-list'
  for (const event of task.activity) {
    const entry = document.createElement('li')
    const message = document.createElement('span')
    message.className = 'activity-message'
    message.textContent = formatTaskActivity(event)
    const time = document.createElement('time')
    time.dateTime = event.createdAt
    time.title = event.createdAt
    time.textContent = formatRelativeTime(event.createdAt)
    entry.append(message, time)
    list.append(entry)
  }
  details.append(list)
  return details
}

function renderTaskAiRuns(runs) {
  const details = document.createElement('details')
  details.className = 'task-ai-runs'
  details.open = true

  const summary = document.createElement('summary')
  summary.textContent = `AI runs (${runs.length})`
  details.append(summary)

  if (runs.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'ai-run-empty'
    empty.textContent = 'No AI runs linked to this task yet.'
    details.append(empty)
    return details
  }

  const list = document.createElement('ol')
  list.className = 'ai-run-list'
  for (const run of runs) {
    const entry = document.createElement('li')
    entry.className = `ai-run ai-run-${run.state}`
    const message = document.createElement('span')
    message.className = 'ai-run-message'
    message.textContent = formatAiRun(run)
    const time = document.createElement('time')
    if (run.createdAt) {
      const createdAt = new Date(run.createdAt)
      if (!Number.isNaN(createdAt.valueOf())) {
        time.dateTime = createdAt.toISOString()
        time.title = time.dateTime
        time.textContent = formatRelativeTime(run.createdAt)
      }
    }
    entry.append(message, time)
    list.append(entry)
  }
  details.append(list)
  return details
}

function renderTaskHistory(task) {
  const wrapper = document.createElement('div')
  wrapper.className = 'task-history'
  wrapper.append(renderTaskActivity(task))
  wrapper.append(renderTaskAiRuns(task.aiRuns ?? []))
  return wrapper
}

async function refreshTaskHistory(taskId) {
  try {
    const detail = await request(`/api/tasks/${taskId}`)
    const item = taskList.querySelector(`.task-item[data-task-id="${taskId}"]`)
    if (!item) return
    item.querySelector('.task-history')?.remove()
    item.append(renderTaskHistory(detail))
  } catch {
    // A deleted task or a transient read failure should not replace the
    // draft status with an unrelated history error.
  }
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

async function loadFiles() {
  try {
    const files = await request('/api/files')
    fileList.replaceChildren()
    fileCount.textContent = `${files.length} tracked`
    if (files.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'empty-state'
      empty.textContent = 'No tracked user files yet. Run Scan user files.'
      fileList.append(empty)
      return
    }
    for (const file of files) {
      const item = document.createElement('li')
      item.className = 'file-item'
      item.textContent = file.path
      fileList.append(item)
    }
  } catch (error) {
    fileStatus.textContent = `Could not load user files: ${error.message}`
    fileStatus.classList.add('is-error')
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

async function cancelJob(jobId) {
  try {
    await request(`/api/local-ai/jobs/${jobId}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

async function waitForJob(jobId, signal) {
  let delay = 2000
  while (true) {
    const job = await request(`/api/local-ai/jobs/${jobId}`, { signal })
    if (job.state === 'done') return job.result
    if (job.state === 'cancelled') {
      activeJobId = null
      throw new DOMException('The batch job was cancelled.', 'AbortError')
    }
    if (job.state === 'error') {
      const error = new Error(job.error || 'The batch job failed.')
      error.status = job.status
      error.retryAfter = job.retryAfter
      throw error
    }
    showStatus(formatJobProgress(job))
    await waitForRetry(delay, signal)
    delay = Math.min(10000, Math.round(delay * 1.5))
  }
}

async function draftTaskIntoForm({ form, taskId, button }) {
  if (draftController) {
    draftController.abort()
    return
  }

  const title = form.elements.title.value.trim()
  if (!title) {
    form.elements.title.focus()
    showStatus('Enter a task title before asking the model to draft it.')
    return
  }

  const controller = new AbortController()
  const defaultLabel = button.dataset.defaultLabel ?? button.textContent
  button.dataset.defaultLabel = defaultLabel
  draftController = controller
  button.textContent = 'Cancel draft'
  button.setAttribute('aria-label', 'Cancel the waiting task draft')
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

      const selectedId = draftModel.value
      const selected = selectedId
        ? status.models?.find((model) => model.id === selectedId)
        : undefined
      if (selectedId && !selected) {
        throw new Error(`The selected model (${selectedId}) is not registered.`)
      }
      const targetState = selected ? selected.state : status.state
      if (targetState === 'unavailable') {
        throw new Error(
          selected?.error || status.error || 'The selected model is unavailable.'
        )
      }

      if (targetState === 'busy') {
        const retryAfter = (selected ? selected.retryAfter : status.retryAfter) ?? 5
        const reasons = selected ? selected.busyReasons : status.busyReasons
        showStatus(formatBusyMessage(reasons, retryAfter))
        await waitForRetry(retryAfter * 1000, signal)
        continue
      }

      const body = buildDraftInput(new FormData(form))
      if (taskId !== undefined) body.task_id = taskId
      if (selectedId) body.model = selectedId
      showStatus(selected ? `Drafting with ${selected.label}…` : 'Local model is idle. Drafting a task brief…')

      try {
        if (selected?.execution === 'batch') {
          const job = await request('/api/local-ai/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
          activeJobId = job.id
          if (signal.aborted) {
            await cancelJob(job.id)
            throw new DOMException('Draft cancelled.', 'AbortError')
          }
          showStatus(`Submitted batch job ${job.id}. Waiting for ${job.model}…`)
          draft = await waitForJob(job.id, signal)
        } else {
          draft = await request('/api/local-ai/refine-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal
          })
        }
        break
      } catch (error) {
        if (error.state !== 'busy') throw error
        const retryAfter = error.retryAfter ?? 5
        showStatus(formatBusyMessage(error.busyReasons, retryAfter))
        await waitForRetry(retryAfter * 1000, signal)
      }
    }

    if (draft) {
      form.elements.description.value = draft.description
      form.elements.acceptance_criteria.value = draft.acceptance_criteria
      showStatus(
        taskId === undefined
          ? 'Draft ready. Review it and edit as needed before adding the task.'
          : 'Draft ready. Review it and save the task to keep your edits.'
      )
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (activeJobId) {
        const cancelled = await cancelJob(activeJobId)
        showStatus(
          cancelled
            ? `Cancelled batch job ${activeJobId}.`
            : 'Draft cancelled, but the remote job may still finish.'
        )
      } else {
        showStatus('AI draft cancelled.')
      }
    } else {
      showStatus(`Could not draft task: ${error.message}`, true)
    }
  } finally {
    activeJobId = null
    if (taskId !== undefined) await refreshTaskHistory(taskId)
    if (draftController === controller) {
      draftController = null
      button.textContent = defaultLabel
      button.removeAttribute('aria-label')
    }
  }
}

draftTaskButton.addEventListener('click', () => {
  draftTaskIntoForm({ form: taskForm, button: draftTaskButton })
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

  if (button.dataset.action === 'history') {
    const current = item.querySelector('.task-history')
    if (current) {
      current.remove()
      return
    }

    try {
      const detail = await request(`/api/tasks/${id}`)
      item.querySelector('.task-edit-form')?.remove()
      item.append(renderTaskHistory(detail))
    } catch (error) {
      showStatus(`Could not load task history: ${error.message}`, true)
    }
    return
  }
  if (button.dataset.action === 'edit') {
    item.querySelector('.task-edit-form')?.remove()
    item.append(createEditForm(task))
    item.querySelector('.task-edit-form [name="title"]').focus()
    return
  }
  if (button.dataset.action === 'draft-edit') {
    const form = item.querySelector('.task-edit-form')
    if (!form) return
    await draftTaskIntoForm({ form, taskId: id, button })
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
loadFiles()
loadModels()

scanFilesButton.addEventListener('click', async () => {
  try {
    const result = await request('/api/files/scan', { method: 'POST' })
    fileStatus.textContent = `Scanned ${result.paths.length} user files (${result.inserted} new).`
    fileStatus.classList.remove('is-error')
    await loadFiles()
  } catch (error) {
    fileStatus.textContent = `Could not scan user files: ${error.message}`
    fileStatus.classList.add('is-error')
  }
})
