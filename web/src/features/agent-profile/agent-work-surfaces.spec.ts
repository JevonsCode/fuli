import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getJson } from '@/api/client'
import type { ProjectAgentRecord } from '@/types'
import { readAgentWorkSurfaces } from './agent-work-surfaces'

vi.mock('@/api/client', () => ({ getJson: vi.fn(), postJson: vi.fn() }))

const agent = (agentId: string, capabilities: string[] = []) =>
  ({ agentId, personalSpaceId: 'space-a', profile: { name: agentId, capabilities } }) as unknown as ProjectAgentRecord

function serve(tasks: unknown[], workflows: unknown[]) {
  vi.mocked(getJson).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agent-tasks?')) return { tasks }
    if (url.startsWith('/api/agent-workflows?')) return { workflows }
    throw new Error(`Unexpected request: ${url}`)
  })
}

const workflow = (status: string) => ({ workflowId: `wf-${status}`, status, pending: null, updatedAt: '2026-10-30T00:00:00Z' })

describe('readAgentWorkSurfaces', () => {
  beforeEach(() => { vi.mocked(getJson).mockReset() })

  it('sends a built-in role to its own workbench page without reading its work', async () => {
    const surfaces = await readAgentWorkSurfaces('space-a', agent('employee.jefa', ['fuli.employee:jefa']))
    expect(surfaces).toEqual({ workbench: '/employees/jefa', workflow: null })
    expect(getJson).not.toHaveBeenCalled()
  })

  it('offers the profile workbench tab for board tasks and the workflow list for open workflows', async () => {
    serve([{ taskId: 't-1', personalSpaceId: 'space-a', status: 'running', ownerAgentId: 'agent-a', participants: [] }], [workflow('active')])
    const surfaces = await readAgentWorkSurfaces('space-a', agent('agent-a'))
    expect(surfaces.workbench).toEqual({ path: '/agents/space-a/agent-a', query: { tab: 'workbench' } })
    expect(surfaces.workflow).toEqual({ path: '/agents/space-a/agent-a', query: { tab: 'workbench' }, hash: '#agent-workflows-heading' })
  })

  it('offers neither when the Agent has no board task, only another Agent\'s task and a retired workflow', async () => {
    serve([{ taskId: 't-2', personalSpaceId: 'space-a', status: 'running', ownerAgentId: 'agent-b', participants: [] }], [workflow('retired')])
    expect(await readAgentWorkSurfaces('space-a', agent('agent-a'))).toEqual({ workbench: null, workflow: null })
  })

  it('reports a failure only when neither read answered', async () => {
    vi.mocked(getJson).mockRejectedValue(new Error('offline'))
    await expect(readAgentWorkSurfaces('space-a', agent('agent-a'))).rejects.toThrow('offline')
  })
})
