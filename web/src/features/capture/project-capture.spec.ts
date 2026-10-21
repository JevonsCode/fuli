import { describe, expect, it } from 'vitest'

import { changedProjectSwitches, projectMode, projectOffSinceDay, projectRecorded, recordsUnregisteredDirectories } from './project-capture'

describe('project capture rules (rec#5 C2, C4-1)', () => {
  it('reads each mode the way FULI applies it to a write', () => {
    expect(projectMode(undefined)).toBe('all')
    expect(projectRecorded(undefined, 'novel')).toBe(true)
    expect(projectRecorded({ enabled: true, projectMode: 'all', excludedProjectIds: ['novel'] }, 'novel')).toBe(true)
    const except = { enabled: true, projectMode: 'all_except' as const, excludedProjectIds: ['job-hunt'] }
    expect([projectRecorded(except, 'job-hunt'), projectRecorded(except, 'novel')]).toEqual([false, true])
    const selected = { enabled: true, projectMode: 'selected' as const, selectedProjectIds: ['thesis'] }
    expect([projectRecorded(selected, 'thesis'), projectRecorded(selected, 'novel')]).toEqual([true, false])
  })

  it('says since when a project that is off stopped being recorded', () => {
    const policy = { enabled: true, projectMode: 'selected' as const, selectedProjectIds: ['thesis'],
      projectsOffSince: { 'job-hunt': '2026-10-20T09:30:00.000Z' }, unlistedProjectsOffSince: '2026-10-19T09:30:00.000Z' }
    expect(projectOffSinceDay(policy, 'thesis')).toBeNull()
    expect(projectOffSinceDay(policy, 'job-hunt')).toBe('2026/10/20')
    expect(projectOffSinceDay(policy, 'novel')).toBe('2026/10/19')
  })

  it('follows the mode default for folders outside projects', () => {
    expect(recordsUnregisteredDirectories({ enabled: true })).toBe(true)
    expect(recordsUnregisteredDirectories({ enabled: true, projectMode: 'selected' })).toBe(false)
    expect(recordsUnregisteredDirectories({ enabled: true, projectMode: 'all', unregisteredDirectories: 'skip' })).toBe(false)
  })

  it('sends only the projects a batch choice changes', () => {
    const policy = { enabled: true, projectMode: 'all_except' as const, excludedProjectIds: ['job-hunt'] }
    expect(changedProjectSwitches(policy, { 'job-hunt': false, novel: true, thesis: false })).toEqual({ thesis: false })
  })
})
