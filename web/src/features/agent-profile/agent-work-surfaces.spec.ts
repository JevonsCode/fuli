import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getJson } from '@/api/client'
import type { ProjectAgentRecord } from '@/types'
import { readAgentWorkSurfaces } from './agent-work-surfaces'

vi.mock('@/api/client', () => ({ getJson: vi.fn(), postJson: vi.fn() }))

const agent = (agentId: string, capabilities: string[] = []) =>
  ({ agentId, personalSpaceId: 'space-a', profile: { name: agentId, capabilities } }) as unknown as ProjectAgentRecord

function serve(workflows: unknown[]) {
  vi.mocked(getJson).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/agent-workflows?')) return { workflows }
    throw new Error(`Unexpected request: ${url}`)
  })
}

const workflow = (status: string) => ({ workflowId: `wf-${status}`, status, pending: null, updatedAt: '2026-10-30T00:00:00Z' })

describe('readAgentWorkSurfaces', () => {
  beforeEach(() => { vi.mocked(getJson).mockReset() })

  it('sends a built-in role to the workbench tab of its page without reading its work', async () => {
    const surfaces = await readAgentWorkSurfaces('space-a', agent('employee.jefa', ['fuli.employee:jefa']))
    expect(surfaces).toEqual({ workbench: { path: '/agents/space-a/employee.jefa', query: { tab: 'workbench' } }, workflow: null })
    expect(getJson).not.toHaveBeenCalled()
  })

  it('gives any other Agent no workbench, whatever its tasks, and its workflow tab when it has open ones', async () => {
    serve([workflow('proposed')])
    const surfaces = await readAgentWorkSurfaces('space-a', agent('agent-a'))
    expect(surfaces).toEqual({ workbench: null, workflow: { path: '/agents/space-a/agent-a', query: { tab: 'workflows' } } })
  })

  it('offers nothing for an Agent with only a retired workflow', async () => {
    serve([workflow('retired')])
    expect(await readAgentWorkSurfaces('space-a', agent('agent-a'))).toEqual({ workbench: null, workflow: null })
  })

  it('reports a failed read', async () => {
    vi.mocked(getJson).mockRejectedValue(new Error('offline'))
    await expect(readAgentWorkSurfaces('space-a', agent('agent-a'))).rejects.toThrow('offline')
  })
})
