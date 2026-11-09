export const workspaceSummary = {
  title: 'Multi-project workspace ready',
  description: 'This monorepo groups a frontend app, a service API, and shared utilities.',
  projects: [
    { name: 'Bash entry', path: 'workspace', role: 'Start and manage workspace services' },
    { name: 'Web app', path: 'apps/web', role: 'Frontend experience' },
    { name: 'Node.js API', path: 'apps/api', role: 'Task CRUD and SQLite writes' },
    { name: 'Python satellite', path: 'apps/python', role: 'SQLite task analytics' },
    { name: 'Shared package', path: 'packages/shared', role: 'Reusable logic' }
  ]
}

export function getProjectCards() {
  return workspaceSummary.projects.map((project) => `
    <li class="project-card">
      <strong>${project.name}</strong>
      <span>${project.role}</span>
      <small>${project.path}</small>
    </li>
  `).join('')
}
