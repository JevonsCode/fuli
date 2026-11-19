import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson }))

import { useConsoleStore } from '@/stores/console'
import type { PersonalProject } from '@/types'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { projectScopeGroups } from './project-scope-choices'
import { readTemporaryProjectSources } from './temporary-project-sources'

// The client that made a temporary project, shown only where the Provider's latest
// answer for the active space proves it. Each case uses its own spaces. Synthetic only.
const hex = (seed: string) => seed.repeat(64).slice(0, 64)
const temporary = (space: string, seed: string, extra: Partial<PersonalProject> = {}): PersonalProject => ({
  project_id: `temporary-${hex(seed)}`, personal_space_id: space, scope_type: 'temporary',
  profile: { name: '临时会话 / Temporary session' }, ...extra,
})
const detailOf = (project: PersonalProject) => projectScopeGroups([project]).temporary[0]!.detail
const codex = (project: PersonalProject) => [{ personal_project_id: project.project_id, source_application: 'codex', session_id: 'synthetic-native-17' }]

function activeSpace(space: string) {
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: space, personalSpaces: [{ id: space, name: 'Synthetic' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
}
function answers() {
  const pending: Array<(rows: unknown) => void> = []
  api.getJson.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
  return pending
}

beforeEach(() => {
  api.getJson.mockReset()
  setActivePinia(createPinia())
})

describe('temporary project sources', () => {
  it('a folded row reads nothing; opening it reads the active space and shows Codex, even with no date', async () => {
    activeSpace('space-open')
    const undated = temporary('space-open', '1', { created_at: null, updated_at: null })
    api.getJson.mockResolvedValue(codex(undated))
    const picker = mount(ProjectScopePicker, { props: { projects: [undated], selected: [], idPrefix: 'spec' } })
    expect(api.getJson).not.toHaveBeenCalled()
    await picker.get('[data-project-scope-temporary-toggle]').trigger('click')
    await flushPromises()
    expect(api.getJson).toHaveBeenCalledWith('/api/personal-projects/temporary-sources?personalSpaceId=space-open', expect.anything())
    expect(picker.get('[data-project-scope-temporary-item]').text()).toContain('Codex')
    expect(detailOf(undated)).toBe('Codex')
    picker.unmount()
  })

  it('the newest answer is the whole truth: a source it no longer proves disappears', async () => {
    activeSpace('space-withdrawn')
    const project = temporary('space-withdrawn', '2')
    api.getJson.mockResolvedValueOnce(codex(project)).mockResolvedValueOnce([])
    readTemporaryProjectSources()
    await flushPromises()
    expect(detailOf(project)).toBe('Codex')
    readTemporaryProjectSources()
    await flushPromises()
    expect(detailOf(project)).toBe('')
  })

  it('an answer to an earlier question never overwrites a newer one', async () => {
    activeSpace('space-order')
    const project = temporary('space-order', '3')
    const pending = answers()
    readTemporaryProjectSources()
    readTemporaryProjectSources()
    pending[1]!([])
    await flushPromises()
    pending[0]!(codex(project))
    await flushPromises()
    expect(detailOf(project)).toBe('')
  })

  it('an answer for a space no longer active is dropped, and another space never shows its sources', async () => {
    activeSpace('space-before')
    const before = temporary('space-before', '4')
    const pending = answers()
    readTemporaryProjectSources()
    activeSpace('space-after')
    pending[0]!(codex(before))
    await flushPromises()
    expect(detailOf(before)).toBe('')
    expect(detailOf(temporary('space-after', '4'))).toBe('')
  })

  it('a failed read shows nothing new, and without the console store nothing is read', async () => {
    activeSpace('space-failing')
    api.getJson.mockRejectedValueOnce(new Error('synthetic refusal'))
    readTemporaryProjectSources()
    await flushPromises()
    expect(detailOf(temporary('space-failing', '5'))).toBe('')
    setActivePinia(undefined as never)
    readTemporaryProjectSources()
    expect(api.getJson).toHaveBeenCalledTimes(1)
  })
})
