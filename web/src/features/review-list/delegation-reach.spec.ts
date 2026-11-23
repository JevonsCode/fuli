import { describe, expect, it } from 'vitest'

import { reachNotice } from './delegation-reach'

// rec issue 124, synthetic project ids only.
const reach = (blockedProjectIds: string[], unassignedAllowed = true, projects = 3) => ({ projects, blockedProjectIds, unassignedAllowed })

describe('reachNotice', () => {
  it('says nothing when Tonborg\'s model may read everything, or when the read did not say', () => {
    expect(reachNotice(reach([]))).toBeNull()
    expect(reachNotice(null)).toBeNull()
    expect(reachNotice(undefined)).toBeNull()
  })

  it('counts the projects it can confirm in, and names general knowledge when that waits too', () => {
    const none = { approved: 0, total: 0 }
    expect(reachNotice(reach(['beta', 'gamma']))).toEqual({ key: 'some', formal: { approved: 1, total: 3 }, temporary: none })
    expect(reachNotice(reach(['beta'], false))).toEqual({ key: 'someAndGeneral', formal: { approved: 2, total: 3 }, temporary: none })
    expect(reachNotice(reach([], false))).toEqual({ key: 'general', formal: { approved: 3, total: 3 }, temporary: none })
  })

  it('counts named and temporary projects apart, so a long list of temporary ones does not read as missing projects', () => {
    // 288 projects: 3 named (1 approved) and 285 temporary (none approved).
    const temporary = Array.from({ length: 285 }, (_, index) => `temporary-${index}`)
    const notice = reachNotice(reach(['beta', 'gamma', ...temporary], false, 288), new Set(temporary))
    expect(notice).toEqual({ key: 'someAndGeneral', formal: { approved: 1, total: 3 }, temporary: { approved: 0, total: 285 } })
  })

  it('says plainly when no project is approved', () => {
    expect(reachNotice(reach(['alpha', 'beta', 'gamma']))!.key).toBe('noProject')
    expect(reachNotice(reach(['alpha', 'beta', 'gamma'], false))!.key).toBe('nothing')
    expect(reachNotice(reach([], false, 0))!.key).toBe('nothing')
  })
})
