import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ getJson }))

import { GRAPH_PAGE_LIMIT, readProjectHistoryEvidence, TASK_READ_LIMIT } from './evidence-reader'

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, type: 'Fact', summary: '', ...extra })
const page = (nodes: unknown[], truncated = false, next_offset: number | null = null) =>
  ({ space_id: 'space-1', nodes, edges: [], truncated, next_offset })
const project = (project_id: string) => ({ project_id, personal_space_id: 'space-1', profile: { name: project_id } })

type Routes = { graph: Record<string, Array<unknown>>, tasks?: Record<string, unknown>, assignments?: unknown }

function route({ graph, tasks = {}, assignments = [] }: Routes, projects: unknown[]) {
  const cursors = new Map<string, number>()
  getJson.mockImplementation(async (url: string) => {
    const query = new URL(url, 'http://local').searchParams
    if (url.startsWith('/api/personal-projects?')) return projects
    if (url.startsWith('/api/project-agent-assignments?')) {
      if (assignments instanceof Error) throw assignments
      return assignments
    }
    const projectId = query.get('personalProjectId') ?? ''
    if (url.startsWith('/api/project-agent-tasks?')) {
      const value = tasks[projectId] ?? []
      if (value instanceof Error) throw value
      return value
    }
    if (url.startsWith('/api/graph?')) {
      const pages = graph[projectId] ?? [page([])]
      const index = cursors.get(projectId) ?? 0
      cursors.set(projectId, index + 1)
      const value = pages[Math.min(index, pages.length - 1)]
      if (value instanceof Error) throw value
      return value
    }
    throw new Error(`unexpected ${url}`)
  })
}

describe('readProjectHistoryEvidence', () => {
  beforeEach(() => { getJson.mockReset() })

  it('reads every graph page and deduplicates an item repeated on the page boundary', async () => {
    route({ graph: { a: [page([node('k1'), node('k2')], true, 500), page([node('k2'), node('k3')])] } }, [project('a')])
    const { projects } = await readProjectHistoryEvidence('space-1')
    expect(projects[0].knowledge).toMatchObject({ status: 'complete', count: 3, pages: 2 })
    expect(getJson).toHaveBeenCalledWith('/api/graph?spaceId=space-1&personalProjectId=a&limit=500&offset=0', expect.anything())
    expect(getJson).toHaveBeenCalledWith('/api/graph?spaceId=space-1&personalProjectId=a&limit=500&offset=500', expect.anything())
  })

  it('reports a repeated or backward cursor as incomplete instead of looping', async () => {
    route({ graph: {
      loop: [page([node('k1')], true, 500), page([node('k2')], true, 500)],
      back: [page([node('k1')], true, 0)],
      missing: [page([node('k1')], true, null)],
    } }, [project('loop'), project('back'), project('missing')])
    const { projects } = await readProjectHistoryEvidence('space-1')
    expect(projects.map(({ knowledge }) => [knowledge.status, knowledge.reason, knowledge.count])).toEqual([
      ['incomplete', 'broken_cursor', 2],
      ['incomplete', 'broken_cursor', 1],
      ['incomplete', 'broken_cursor', 1],
    ])
    expect(getJson.mock.calls.filter(([url]) => String(url).includes('personalProjectId=loop&')).length).toBe(3)
  })

  it('treats an empty truncated page as incomplete and an empty final page as a complete zero', async () => {
    route({ graph: { stalled: [page([], true, 500)], empty: [page([])] } }, [project('stalled'), project('empty')])
    const { projects } = await readProjectHistoryEvidence('space-1')
    expect(projects[0].knowledge).toMatchObject({ status: 'incomplete', reason: 'empty_page', count: 0 })
    expect(projects[1].knowledge).toMatchObject({ status: 'complete', count: 0 })
  })

  it('stops at the page limit and says the history is incomplete', async () => {
    const endless = Array.from({ length: GRAPH_PAGE_LIMIT + 2 }, (_, index) =>
      page([node(`k${index}`)], true, (index + 1) * 500))
    route({ graph: { big: endless } }, [project('big')])
    const { projects } = await readProjectHistoryEvidence('space-1')
    expect(projects[0].knowledge).toMatchObject({ status: 'incomplete', reason: 'page_limit', count: GRAPH_PAGE_LIMIT })
  })

  it('keeps other projects complete when one read fails and marks capped task reads as incomplete', async () => {
    const full = Array.from({ length: TASK_READ_LIMIT }, (_, index) => ({ taskId: `t${index}` }))
    route({
      graph: { broken: [new Error('provider down')], ok: [page([node('k1')])] },
      tasks: { broken: [{ taskId: 't1' }], ok: full },
      assignments: [{ personalProjectId: 'ok', status: 'ended' }, { personalProjectId: 'other', status: 'active' }],
    }, [project('broken'), project('ok')])
    const { projects } = await readProjectHistoryEvidence('space-1')
    expect(projects[0].knowledge).toMatchObject({ status: 'failed', reason: 'request_failed' })
    expect(projects[0].tasks).toMatchObject({ status: 'complete', count: 1 })
    expect(projects[1].knowledge).toMatchObject({ status: 'complete', count: 1 })
    expect(projects[1].tasks).toMatchObject({ status: 'incomplete', reason: 'read_limit', count: TASK_READ_LIMIT })
    expect(projects[0].assignments).toMatchObject({ status: 'complete', count: 0 })
    expect(projects[1].assignments).toMatchObject({ status: 'complete', count: 1 })
    expect(getJson).toHaveBeenCalledWith('/api/project-agent-tasks?personalSpaceId=space-1&personalProjectId=ok&limit=200', expect.anything())
  })

  it('marks every project assignment as failed when the shared assignment read fails', async () => {
    route({ graph: {}, assignments: new Error('offline') }, [project('a')])
    const { projects } = await readProjectHistoryEvidence('space-1')
    expect(projects[0].assignments).toMatchObject({ status: 'failed', reason: 'request_failed' })
  })

  it('counts explicit project relations and knowledge referenced by another project', async () => {
    route({ graph: { a: [page([
      node('personal-project:a', { type: 'PersonalProject' }),
      node('personal-project-related:b', { type: 'RelatedPersonalProject' }),
      node('k1', { project_references: [{ project_id: 'b', status: 'active' }] }),
      node('k2', { project_references: [{ project_id: 'a', status: 'active' }, { project_id: 'c', status: 'revoked' }] }),
    ])] } }, [project('a')])
    const { projects } = await readProjectHistoryEvidence('space-1')
    expect(projects[0].knowledge).toMatchObject({ status: 'complete', count: 2, relations: 1, referencedElsewhere: 1 })
  })

  it('reports real progress and uses only read requests', async () => {
    route({ graph: {} }, [project('a'), project('b')])
    const progress: Array<[number, number]> = []
    await readProjectHistoryEvidence('space-1', { onProgress: (done, total) => progress.push([done, total]) })
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]])
    expect(getJson.mock.calls.every(([url]) => typeof url === 'string' && url.startsWith('/api/'))).toBe(true)
  })

  it('fails as a whole when the project list itself cannot be read', async () => {
    getJson.mockRejectedValue(new Error('offline'))
    await expect(readProjectHistoryEvidence('space-1')).rejects.toThrow('offline')
  })
})
