import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentWorkstreams } from './project-team-api'

afterEach(() => { vi.unstubAllGlobals() })

describe('an FLA’s workstream ledger', () => {
  it('keeps the owner’s name and how far each line got, as the server sends them', async () => {
    const line = { assignmentId: 'ws-1', name: 'Synthetic line', terms: ['alpha'], ownerAgentId: 'fla-1', ownerName: 'Lumen',
      ownerOnProject: true, revision: 1, latestTask: { status: 'running', summary: 'Synthetic step', at: '2026-11-20T08:00:00Z' } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agentId: 'fla-1',
      projects: [{ projectId: 'p-1', projectName: 'Synthetic project', leads: false, workstreams: [line] }] }))))
    const ledger = await readAgentWorkstreams('fla-1')
    expect(ledger.projects[0]!.workstreams[0]).toMatchObject({ ownerName: 'Lumen', latestTask: { summary: 'Synthetic step' } })
  })
})
