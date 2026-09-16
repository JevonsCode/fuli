import { describe, expect, it, vi } from 'vitest'
const getJson = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ getJson }))
import { readPersonalProfileGraph } from './personal-profile-graph'

describe('complete profile history', () => {
  it('loads older taste and personality and deduplicates endpoints across pages', async () => {
    getJson.mockReset().mockResolvedValueOnce({ nodes: [{ id: 'judgment' }], edges: [], truncated: true, next_offset: 500 })
      .mockResolvedValueOnce({ nodes: [{ id: 'judgment' }, { id: 'taste' }, { id: 'personality' }], edges: [], truncated: false })
    const signal = new AbortController().signal
    const graph = await readPersonalProfileGraph('space-a', signal)
    expect(graph.nodes.map(node => node.id)).toEqual(['judgment', 'taste', 'personality'])
    expect(getJson).toHaveBeenNthCalledWith(1, '/api/graph?spaceId=space-a&limit=500&offset=0', { signal })
    expect(getJson).toHaveBeenLastCalledWith('/api/graph?spaceId=space-a&limit=500&offset=500', { signal })
  })
  it('rejects a broken cursor instead of presenting partial counts as complete', async () => {
    getJson.mockReset().mockResolvedValue({ nodes: [], edges: [], truncated: true, next_offset: 0 })
    await expect(readPersonalProfileGraph('space-a')).rejects.toThrow('incomplete')
    expect(getJson).toHaveBeenCalledTimes(1)
  })
})
