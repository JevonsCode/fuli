import { describe, expect, it } from 'vitest'
import { flaGroup, groupFlas, groupFlasByScope } from './fla-groups'

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

  it('splits the FLAs on a project from the global ones, keeping order and dropping an empty group', () => {
    const rows = [{ id: 'a', projects: 0 }, { id: 'b', projects: 2 }, { id: 'c', projects: 1 }]
    expect(groupFlasByScope(rows, row => row.projects > 0)).toEqual([
      { key: 'team', rows: [rows[1], rows[2]] },
      { key: 'global', rows: [rows[0]] },
    ])
    expect(groupFlasByScope(rows.slice(1), row => row.projects > 0)).toEqual([{ key: 'team', rows: rows.slice(1) }])
  })
})
