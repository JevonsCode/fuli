import { describe, expect, it } from 'vitest'

import { discoverPersonalProjectResults, projectDiscoverySummary } from './project-discovery'

describe('personal project search discovery', () => {
  it('subtracts aggregate results and ranks project-only matches', async () => {
    const projects = [
      {
        project_id: 'project-a',
        personal_space_id: 'space-1',
        profile: { name: 'A project' },
      },
      {
        project_id: 'project-b',
        personal_space_id: 'space-1',
        profile: { name: 'B project' },
      },
    ]
    const discovery = await discoverPersonalProjectResults({
      personalSpaceId: 'space-1',
      projects,
      query: 'release',
      baseline: {
        entities: [{ id: 'shared', name: 'Shared result', score: 1 }],
      },
      request: async (url) => {
        const projectId = new URL(url, 'http://localhost').searchParams
          .get('personalProjectId')
        if (projectId === 'project-a') {
          return {
            entities: [
              { id: 'shared', name: 'Shared result', score: 1 },
              { id: 'project-only', name: 'Project result', score: 8 },
            ],
          }
        }
        return { entities: [{ id: 'shared', name: 'Shared result', score: 1 }] }
      },
    })

    expect(discovery.matches).toHaveLength(1)
    expect(discovery.matches[0]).toMatchObject({
      project: { project_id: 'project-a' },
      count: 1,
      score: 8,
    })
    expect(projectDiscoverySummary(discovery)).toContain('其他个人项目中有候选内容')
  })

  it('stops checking further project batches when the search is aborted', async () => {
    const controller = new AbortController()
    let requests = 0
    const projects = Array.from({ length: 5 }, (_, index) => ({
      project_id: `project-${index}`,
      personal_space_id: 'space-1',
      profile: { name: `Project ${index}` },
    }))

    await expect(discoverPersonalProjectResults({
      personalSpaceId: 'space-1',
      projects,
      query: 'release',
      baseline: {},
      signal: controller.signal,
      request: async (_url, init) => {
        requests += 1
        if (requests === 1) controller.abort()
        init?.signal?.throwIfAborted()
        return {}
      },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(requests).toBeLessThan(projects.length)
  })

  it('does not imply that unsearched projects were checked', () => {
    expect(projectDiscoverySummary({
      checked: 0,
      total: 0,
      failed: 0,
      matches: [],
    })).toBe('当前没有其他个人项目可继续检查。')

    expect(projectDiscoverySummary({
      checked: 12,
      total: 20,
      failed: 0,
      matches: [],
    })).toContain('已检查前 12 / 20 个其他个人项目')
  })
})
