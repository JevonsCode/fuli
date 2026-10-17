import { describe, expect, it } from 'vitest'
import type { PersonalProject } from '@/types'
import { isConversationFallback, pickerOrder, projectDisplayName } from './project-origin'

const fallbackId = (seed: string) => `conversation-${seed.repeat(64).slice(0, 64)}`
const project = (id: string, name: string, updatedAt: string | null = null, createdAt: string | null = null): PersonalProject => ({
  project_id: id, personal_space_id: 'space-a', profile: { name } as PersonalProject['profile'], updated_at: updatedAt, created_at: createdAt,
})

describe('project origin', () => {
  it('recognises fallback session projects by their generated ID, never by name', () => {
    expect(isConversationFallback(project(fallbackId('a'), 'Anything'))).toBe(true)
    expect(isConversationFallback(project('conversation-notes', '会话项目 / Conversation project'))).toBe(false)
  })

  it('names fallback projects by when they were last used so they can be told apart', () => {
    const name = projectDisplayName(project(fallbackId('b'), '会话项目 / Conversation project', '2026-10-17T07:20:00Z'))
    expect(name).toMatch(/^会话项目 · /)
    expect(name).not.toContain('Conversation project')
    expect(projectDisplayName(project(fallbackId('c'), '会话项目 / Conversation project'))).toBe('会话项目')
    expect(projectDisplayName(project('fuli', 'Fuli console'))).toBe('Fuli console')
  })

  it('lists people-made projects first in their order and fallbacks after, newest first', () => {
    const ordered = pickerOrder([
      project(fallbackId('1'), 'x', '2026-10-15T00:00:00Z'),
      project('zeta', 'Zeta'),
      project(fallbackId('2'), 'x', '2026-10-17T00:00:00Z'),
      project('alpha', 'Alpha'),
    ])
    expect(ordered.map(item => item.project_id)).toEqual(['zeta', 'alpha', fallbackId('2'), fallbackId('1')])
  })

  it('falls back to the creation time and orders undated fallbacks last, the same way every time', () => {
    const input = [
      project(fallbackId('a'), 'x'),
      project(fallbackId('c'), 'x', null, '2026-10-16T00:00:00Z'),
      project(fallbackId('b'), 'x', 'not a time'),
      project(fallbackId('d'), 'x', '2026-10-17T00:00:00Z'),
    ]
    // Undated and unreadable times tie as oldest and fall back to ID order.
    const expected = [fallbackId('d'), fallbackId('c'), fallbackId('a'), fallbackId('b')]
    expect(pickerOrder(input).map(item => item.project_id)).toEqual(expected)
    expect(pickerOrder([...input].reverse()).map(item => item.project_id)).toEqual(expected)
    expect(projectDisplayName(input[1]!)).toMatch(/^会话项目 · /)
  })
})
