import { describe, expect, it, vi } from 'vitest'
const getJson = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ getJson }))
import { graphPageShape, readPersonalProfileGraph } from './personal-profile-graph'

describe('complete profile history', () => {
  it('rejects a backwards cursor and never accepts the partial history after it', async () => {
    getJson.mockReset().mockResolvedValueOnce({ nodes: [], edges: [], truncated: true, next_offset: 500 })
      .mockResolvedValueOnce({ nodes: [], edges: [], truncated: true, next_offset: 250 })
      .mockResolvedValueOnce({ nodes: [{ id: 'partial' }], edges: [], truncated: false })
    await expect(readPersonalProfileGraph('space-a')).rejects.toThrow('incomplete')
    expect(getJson).toHaveBeenCalledTimes(2)
  })
  it('loads older taste and personality and deduplicates endpoints across pages', async () => {
    getJson.mockReset().mockResolvedValueOnce({ nodes: [{ id: 'judgment' }], edges: [], truncated: true, next_offset: 500 })
      .mockResolvedValueOnce({ nodes: [{ id: 'judgment' }, { id: 'taste' }, { id: 'personality' }], edges: [], truncated: false })
    const signal = new AbortController().signal
    const graph = await readPersonalProfileGraph('space-a', signal)
    expect(graph.nodes.map(node => node.id)).toEqual(['judgment', 'taste', 'personality'])
    expect(getJson).toHaveBeenNthCalledWith(1, '/api/graph?spaceId=space-a&limit=500&offset=0', graphPageShape, { signal })
    expect(getJson).toHaveBeenLastCalledWith('/api/graph?spaceId=space-a&limit=500&offset=500', graphPageShape, { signal })
  })
  it('rejects a broken cursor instead of presenting partial counts as complete', async () => {
    getJson.mockReset().mockResolvedValue({ nodes: [], edges: [], truncated: true, next_offset: 0 })
    await expect(readPersonalProfileGraph('space-a')).rejects.toThrow('incomplete')
    expect(getJson).toHaveBeenCalledTimes(1)
  })
  it('checks each page for the lists and the stated case the page counts by', () => {
    const valid = { nodes: [{ id: 'a', stated_case: 'making decks', preference_qualifiers: { constraint: 'hard' } }],
      edges: [{ id: 'b' }], truncated: false }
    expect(graphPageShape.schema.safeParse(valid).success).toBe(true)
    for (const page of [{ nodes: [], truncated: false }, { nodes: [{ id: 'a', stated_case: 3 }], edges: [] },
      { nodes: [{ id: 'a', preference_qualifiers: 'hard' }], edges: [] }]) {
      expect(graphPageShape.schema.safeParse(page).success).toBe(false)
    }
  })
})
