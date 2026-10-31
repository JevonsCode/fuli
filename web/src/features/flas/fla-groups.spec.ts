import { describe, expect, it } from 'vitest'
import { flaGroup, groupFlas } from './fla-groups'

describe('FLA groups', () => {
  it('puts what needs the person first and never calls an unknown state idle', () => {
    expect(flaGroup('active', 'blocked')).toBe('attention')
    expect(flaGroup('active', 'awaiting_review')).toBe('attention')
    expect(flaGroup('active', 'running')).toBe('working')
    expect(flaGroup('active', 'none')).toBe('idle')
    expect(flaGroup('active', 'unreported')).toBe('unknown')
    expect(flaGroup('active', 'loading')).toBe('unknown')
    expect(flaGroup('active', undefined)).toBe('unknown')
  })

  it('keeps switched-off FLAs apart whatever they last did', () => {
    expect(flaGroup('inactive', 'running')).toBe('inactive')
    expect(flaGroup('archived', 'none')).toBe('inactive')
  })

  it('keeps row order inside each group and drops empty groups', () => {
    const rows = [
      { id: 'a', group: 'working' as const },
      { id: 'b', group: 'attention' as const },
      { id: 'c', group: 'working' as const },
    ]
    expect(groupFlas(rows, row => row.group)).toEqual([
      { key: 'attention', rows: [rows[1]] },
      { key: 'working', rows: [rows[0], rows[2]] },
    ])
  })
})
