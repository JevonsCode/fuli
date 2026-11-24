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

  it('says how far a line got only in the shape the server sends, and drops what it does not know', async () => {
    const lines = [
      { assignmentId: 'ws-1', name: 'Synthetic line', terms: [], ownerAgentId: 'fla-1', ownerName: null, ownerOnProject: false, revision: 1,
        latestTask: null, progressUnreadable: true, internalNote: 'Synthetic extra' },
      { assignmentId: 'ws-2', name: 'Synthetic other', terms: [], ownerAgentId: 'fla-1', ownerName: 'Lumen', ownerOnProject: true, revision: 2,
        latestTask: { status: null, summary: null, at: null } },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agentId: 'fla-1',
      projects: [{ projectId: 'p-1', projectName: 'Synthetic project', leads: false, workstreams: lines }] }))))
    const [first, second] = (await readAgentWorkstreams('fla-1')).projects[0]!.workstreams
    expect(first).toMatchObject({ ownerName: null, latestTask: null, progressUnreadable: true })
    expect(first).not.toHaveProperty('internalNote')
    expect(second!.latestTask).toEqual({ status: null, summary: null, at: null })
  })

  it('refuses a line whose progress is not the recorded task shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agentId: 'fla-1', projects: [{ projectId: 'p-1',
      projectName: 'Synthetic project', leads: false, workstreams: [{ assignmentId: 'ws-1', name: 'Synthetic line', terms: [],
        ownerAgentId: 'fla-1', ownerName: 'Lumen', ownerOnProject: true, revision: 1, latestTask: 'running' }] }] }))))
    await expect(readAgentWorkstreams('fla-1')).rejects.toThrow()
  })
})
