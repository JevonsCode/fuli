import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ProjectAgentRecord } from '@/types'
import { readAgentWorkSurfaces } from './agent-work-surfaces'
import { useAgentWorkSurfaces } from './use-agent-work-surfaces'

vi.mock('./agent-work-surfaces', () => ({ readAgentWorkSurfaces: vi.fn() }))

const agent = { agentId: 'a-1' } as ProjectAgentRecord
const none = { workbench: null, workflow: null }
const some = { workbench: null, workflow: { path: '/agents/a-1' } }

describe('useAgentWorkSurfaces', () => {
  it('shows new work on the next open instead of a kept "nothing here"', async () => {
    const work = useAgentWorkSurfaces(ref('space-a'))
    vi.mocked(readAgentWorkSurfaces).mockResolvedValueOnce(none).mockResolvedValueOnce(some)
    await work.open(agent)
    expect(work.ready('a-1')).toEqual(none)
    await work.open(agent)
    expect(work.ready('a-1')).toEqual(some)
  })

  it('tells a failed read from an empty one, and the next open recovers', async () => {
    const work = useAgentWorkSurfaces(ref('space-a'))
    vi.mocked(readAgentWorkSurfaces).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(some)
    await work.open(agent)
    expect(work.surfaces.value['a-1']).toEqual({ status: 'error' })
    await work.open(agent)
    expect(work.ready('a-1')).toEqual(some)
  })

  it('keeps the last answer when a later read fails', async () => {
    const work = useAgentWorkSurfaces(ref('space-a'))
    vi.mocked(readAgentWorkSurfaces).mockResolvedValueOnce(some).mockRejectedValueOnce(new Error('offline'))
    await work.open(agent)
    await work.open(agent)
    expect(work.ready('a-1')).toEqual(some)
  })
})
