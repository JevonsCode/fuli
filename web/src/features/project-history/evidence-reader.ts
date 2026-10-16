import { getJson } from '@/api/client'
import { appendKnowledgeGraphPage, knowledgeItems } from '@/features/knowledge/model'
import type { KnowledgeGraph, PersonalProject } from '@/types'

// Read-only evidence for the history preview. Every request is a GET against
// an existing endpoint; nothing here creates, archives, merges or deletes.
export const GRAPH_PAGE_SIZE = 500
export const GRAPH_PAGE_LIMIT = 40
// The task list has no cursor; reaching this cap means more may exist.
export const TASK_READ_LIMIT = 200

export type EvidenceStatus = 'complete' | 'incomplete' | 'failed'
export type IncompleteReason =
  | 'broken_cursor' | 'empty_page' | 'page_limit' | 'read_limit' | 'request_failed'

export interface CountEvidence {
  status: EvidenceStatus
  count: number
  reason?: IncompleteReason
}

export interface KnowledgeEvidence extends CountEvidence {
  pages: number
  relations: number
  referencedElsewhere: number
}

export interface HistoryProject extends PersonalProject {
  created_at?: string | null
  updated_at?: string | null
}

export interface ProjectEvidence {
  project: HistoryProject
  knowledge: KnowledgeEvidence
  tasks: CountEvidence
  assignments: CountEvidence
}

interface ReadOptions {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export async function readProjectHistoryEvidence(spaceId: string, options: ReadOptions = {}) {
  const { signal, onProgress } = options
  const space = encodeURIComponent(spaceId)
  const projects = await getJson<HistoryProject[]>(`/api/personal-projects?personalSpaceId=${space}`, { signal })
  if (!Array.isArray(projects)) throw new Error('Invalid personal project list')
  const assignments = await readAssignments(space, signal)
  const evidence: ProjectEvidence[] = []
  onProgress?.(0, projects.length)
  for (const project of projects) {
    evidence.push({
      project,
      knowledge: await readKnowledge(spaceId, project.project_id, signal),
      tasks: await readTasks(space, project.project_id, signal),
      assignments: assignments.status === 'failed'
        ? { status: 'failed', count: 0, reason: 'request_failed' }
        : { status: 'complete', count: assignments.byProject.get(project.project_id) ?? 0 },
    })
    onProgress?.(evidence.length, projects.length)
  }
  return { spaceId, projects: evidence }
}

async function readAssignments(space: string, signal?: AbortSignal) {
  try {
    const records = await getJson<Array<{ personalProjectId?: string | null }>>(
      `/api/project-agent-assignments?personalSpaceId=${space}`, { signal })
    if (!Array.isArray(records)) throw new Error('Invalid assignment list')
    const byProject = new Map<string, number>()
    for (const { personalProjectId } of records) {
      if (personalProjectId) byProject.set(personalProjectId, (byProject.get(personalProjectId) ?? 0) + 1)
    }
    return { status: 'complete' as const, byProject }
  } catch (error) {
    if (signal?.aborted) throw error
    return { status: 'failed' as const, byProject: new Map<string, number>() }
  }
}

async function readTasks(space: string, projectId: string, signal?: AbortSignal): Promise<CountEvidence> {
  try {
    const tasks = await getJson<unknown[]>(
      `/api/project-agent-tasks?personalSpaceId=${space}&personalProjectId=${encodeURIComponent(projectId)}&limit=${TASK_READ_LIMIT}`,
      { signal })
    if (!Array.isArray(tasks)) throw new Error('Invalid task list')
    return tasks.length >= TASK_READ_LIMIT
      ? { status: 'incomplete', count: tasks.length, reason: 'read_limit' }
      : { status: 'complete', count: tasks.length }
  } catch (error) {
    if (signal?.aborted) throw error
    return { status: 'failed', count: 0, reason: 'request_failed' }
  }
}

async function readKnowledge(spaceId: string, projectId: string, signal?: AbortSignal): Promise<KnowledgeEvidence> {
  const query = new URLSearchParams({
    spaceId, personalProjectId: projectId, limit: String(GRAPH_PAGE_SIZE), offset: '0',
  })
  let graph: KnowledgeGraph | null = null
  let offset = 0
  let pages = 0
  const visited = new Set<number>([0])
  const result = (status: EvidenceStatus, reason?: IncompleteReason) =>
    knowledgeEvidence(graph, projectId, pages, status, reason)
  try {
    while (pages < GRAPH_PAGE_LIMIT) {
      const page = await getJson<KnowledgeGraph>(`/api/graph?${query}`, { signal })
      if (!Array.isArray(page?.nodes) || !Array.isArray(page?.edges)) throw new Error('Invalid graph page')
      pages += 1
      graph = appendKnowledgeGraphPage(graph, page)
      if (!page.truncated) return result('complete')
      if (!page.nodes.length && !page.edges.length) return result('incomplete', 'empty_page')
      const next = page.next_offset
      if (!Number.isInteger(next) || next == null || next <= offset || visited.has(next)) {
        return result('incomplete', 'broken_cursor')
      }
      visited.add(next)
      offset = next
      query.set('offset', String(next))
    }
    return result('incomplete', 'page_limit')
  } catch (error) {
    if (signal?.aborted) throw error
    return result('failed', 'request_failed')
  }
}

function knowledgeEvidence(
  graph: KnowledgeGraph | null,
  projectId: string,
  pages: number,
  status: EvidenceStatus,
  reason?: IncompleteReason,
): KnowledgeEvidence {
  const items = knowledgeItems(graph)
  const referencedElsewhere = items.filter(({ projectReferences }) => projectReferences.some(reference =>
    reference.status === 'active' && reference.project_id && reference.project_id !== projectId)).length
  const relations = (graph?.nodes ?? []).filter(({ type }) => type === 'RelatedPersonalProject').length
  return { status, count: items.length, pages, relations, referencedElsewhere, ...(reason ? { reason } : {}) }
}
