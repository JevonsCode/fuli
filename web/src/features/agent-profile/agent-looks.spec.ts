import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson, putJson }))

const { agentLooks, forgetAgentLooks, loadAgentLooks, saveAgentLook } = await import('./agent-looks')

const at = '2026-11-01T00:00:00Z'
afterEach(() => { forgetAgentLooks(); getJson.mockReset(); putJson.mockReset() })

describe('agent looks', () => {
  it('reads the changed looks once per space', async () => {
    getJson.mockResolvedValue({ avatars: [
      { agentId: 'agent-a', kind: 'generated', seed: 'seed-1', updatedAt: at },
      { agentId: 'agent-b', kind: 'image', imageVersion: 'v1', updatedAt: at },
    ] })
    await Promise.all([loadAgentLooks('space-a'), loadAgentLooks('space-a')])
    expect(getJson).toHaveBeenCalledTimes(1)
    expect(getJson).toHaveBeenCalledWith('/api/agent-avatars?personalSpaceId=space-a')
    expect([...agentLooks.value.keys()]).toEqual(['agent-a', 'agent-b'])
  })

  it('leaves every Agent on its default when the console has no looks route', async () => {
    getJson.mockRejectedValue(new ApiError('Not found', 404))
    await loadAgentLooks('space-a')
    expect(agentLooks.value.size).toBe(0)
  })

  it('shows a saved look at once, reads the list again, and drops a look set back to default', async () => {
    getJson.mockResolvedValue({ avatars: [] })
    await loadAgentLooks('space-a')
    let listed: unknown[] = []
    getJson.mockImplementation(async () => ({ avatars: listed }))
    const saved = { agentId: 'agent-a', kind: 'generated', seed: 'seed-2', updatedAt: at }
    putJson.mockResolvedValue(saved)
    listed = [saved]
    await saveAgentLook('space-a', 'agent-a', { kind: 'generated', seed: 'seed-2' })
    expect(putJson).toHaveBeenCalledWith('/api/agent-avatars/agent-a', { personalSpaceId: 'space-a', look: { kind: 'generated', seed: 'seed-2' } })
    expect(agentLooks.value.get('agent-a')).toMatchObject({ kind: 'generated', seed: 'seed-2' })
    expect(getJson).toHaveBeenCalledTimes(2)

    putJson.mockResolvedValue({ agentId: 'agent-a', kind: 'default', updatedAt: at })
    listed = []
    await saveAgentLook('space-a', 'agent-a', { kind: 'default' })
    expect(agentLooks.value.has('agent-a')).toBe(false)
  })

  it('reports a refused save and keeps the look shown before it', async () => {
    getJson.mockResolvedValue({ avatars: [{ agentId: 'agent-a', kind: 'generated', seed: 'seed-1', updatedAt: at }] })
    await loadAgentLooks('space-a')
    putJson.mockRejectedValue(new ApiError('too large', 400))
    await expect(saveAgentLook('space-a', 'agent-a', { kind: 'image', data: 'AAAA' })).rejects.toThrow('too large')
    expect(agentLooks.value.get('agent-a')).toMatchObject({ seed: 'seed-1' })
  })
})
