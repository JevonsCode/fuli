import { getJson } from '@/api/client'
import type { EmployeeBoardItem, EmployeeProjectBoard } from './EmployeeTaskBoard.vue'

export interface SharedProject { id: string; slug: string }
export async function publicProjectReport(project: SharedProject): Promise<EmployeeProjectBoard> {
  const value = await getJson<{ project: { id: string; name: string }; items: EmployeeBoardItem[] }>(`/employee-workspaces/jefa/${encodeURIComponent(project.id)}/api/public/${encodeURIComponent(project.slug)}`)
  if (value?.project?.id !== project.id || typeof value.project.name !== 'string' || !Array.isArray(value.items)) throw new Error('Invalid public projection')
  // A public report must never fall back to private board or task endpoints.
  const items = value.items.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string'
    && ['planned', 'active', 'blocked', 'review', 'done'].includes(item.status))
    .map(item => ({ id: item.id, projectId: project.id, title: item.title, status: item.status, priority: item.priority }))
  return { project: { id: value.project.id, name: value.project.name }, items, total: items.length, truncated: false }
}
export function reportUrl(projects: SharedProject[], origin: string) {
  const url = new URL('/reports/jefa', origin)
  // The fragment keeps capability tokens out of HTTP access logs and Referer headers.
  url.hash = new URLSearchParams(projects.map(project => ['p', JSON.stringify([project.id, project.slug])])).toString()
  return url.href
}
export function reportProjects(hash: string): SharedProject[] {
  const entries = new URLSearchParams(hash.replace(/^#/, '')).getAll('p')
  if (!entries.length || entries.length > 100) throw new Error('Invalid report scope')
  const seen = new Set<string>()
  return entries.map(entry => {
    const value: unknown = JSON.parse(entry)
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !value[0] || value[0].length > 160 || typeof value[1] !== 'string' || !/^share-[a-zA-Z0-9-]{16,100}$/.test(value[1]) || seen.has(value[0])) throw new Error('Invalid report scope')
    seen.add(value[0])
    return { id: value[0], slug: value[1] }
  })
}
