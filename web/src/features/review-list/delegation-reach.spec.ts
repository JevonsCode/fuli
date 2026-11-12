import { describe, expect, it } from 'vitest'

import { reachNotice } from './delegation-reach'

// rec#124, synthetic project ids only.
const reach = (blockedProjectIds: string[], unassignedAllowed = true, projects = 3) => ({ projects, blockedProjectIds, unassignedAllowed })

describe('reachNotice', () => {
  it('says nothing when Tonborg\'s model may read everything, or when the read did not say', () => {
    expect(reachNotice(reach([]))).toBeNull()
    expect(reachNotice(null)).toBeNull()
    expect(reachNotice(undefined)).toBeNull()
  })

  it('counts the projects it can confirm in, and names general knowledge when that waits too', () => {
    expect(reachNotice(reach(['beta', 'gamma']))).toEqual({ key: 'some', approved: 1, total: 3 })
    expect(reachNotice(reach(['beta'], false))).toEqual({ key: 'someAndGeneral', approved: 2, total: 3 })
    expect(reachNotice(reach([], false))).toEqual({ key: 'general', approved: 3, total: 3 })
  })

  it('says plainly when no project is approved', () => {
    expect(reachNotice(reach(['alpha', 'beta', 'gamma']))!.key).toBe('noProject')
    expect(reachNotice(reach(['alpha', 'beta', 'gamma'], false))!.key).toBe('nothing')
    expect(reachNotice(reach([], false, 0))!.key).toBe('nothing')
  })
})
