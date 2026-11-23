import { describe, expect, it } from 'vitest'
import { MAX_BORROWED_PROJECTS, readEach, toggleBorrowed } from './borrowed-contexts'

const ids = (count: number, prefix = 'synthetic') => Array.from({ length: count }, (_, index) => `${prefix}-${index}`)

describe('borrowed projects', () => {
  it('adds up to the limit and says how many did not fit; turning off always applies', () => {
    const many = ids(259, 'temporary')
    const added = toggleBorrowed(['formal-a'], many, true)
    expect(added.ids).toHaveLength(MAX_BORROWED_PROJECTS)
    expect(added.ids[0]).toBe('formal-a')
    expect(added.refused).toBe(259 - (MAX_BORROWED_PROJECTS - 1))
    expect(toggleBorrowed(added.ids, many, false)).toEqual({ ids: ['formal-a'], refused: 0 })
    // Already borrowed ones are not counted as refused.
    expect(toggleBorrowed(added.ids, added.ids, true)).toEqual({ ids: added.ids, refused: 0 })
  })

  it('reads a few graphs at a time, never all at once, and answers in order', async () => {
    let running = 0
    let most = 0
    const answers = await readEach(ids(MAX_BORROWED_PROJECTS), async (id) => {
      running += 1
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, 1))
      running -= 1
      return id
    })
    expect(answers).toEqual(ids(MAX_BORROWED_PROJECTS))
    expect(most).toBeLessThanOrEqual(4)
  })
})
