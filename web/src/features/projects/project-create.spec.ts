import { beforeEach, describe, expect, it, vi } from 'vitest'

const { putJson } = vi.hoisted(() => ({ putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ putJson }))
import { createPersonalProject, newProjectId } from './project-create'

describe('new project helpers', () => {
  beforeEach(() => putJson.mockReset())

  it('derives a readable ID that never reuses an existing project ID', () => {
    expect(newProjectId('Fuli Console', [])).toBe('fuli-console')
    expect(newProjectId('Fuli Console', ['fuli-console', 'fuli-console-2'])).toBe('fuli-console-3')
    expect(newProjectId('控制台 改版', [])).toBe('控制台-改版')
    expect(newProjectId('!!!', [])).toBe('project')
  })

  it('sends a create-only profile with excluded lines as boundaries and an optional source', async () => {
    putJson.mockResolvedValue({})
    await createPersonalProject('space-a', 'fuli-console', {
      name: ' Fuli Console ', purpose: 'Run the console.', includes: 'UI work',
      excludes: 'Personal taste\n\nOther products\nPersonal taste', source: 'https://example.test/repo',
    })
    expect(putJson).toHaveBeenCalledWith('/api/personal-projects', {
      personalSpaceId: 'space-a', projectId: 'fuli-console', createOnly: true,
      profile: {
        name: 'Fuli Console', purpose: 'Run the console.', scope: 'UI work', lifecycle: 'active',
        boundaries: ['Personal taste', 'Other products'],
        sources: [{ key: 'source-1', kind: 'other', title: 'https://example.test/repo', uri: 'https://example.test/repo', sensitivity: 'normal' }],
      },
    })
    await createPersonalProject('space-a', 'only-name', { name: 'Only name', purpose: '', includes: '', excludes: '', source: '' })
    expect(putJson.mock.calls[1]![1].profile).toMatchObject({ purpose: null, scope: null, boundaries: [], sources: [] })
  })
})
