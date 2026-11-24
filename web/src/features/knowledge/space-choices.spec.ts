import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { computed } from 'vue'
import type { KnowledgeScope } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'
import type { PersonalProject } from '@/types'
import { useSpaceChoices } from './space-choices'

// The graph toolbar's spaces and projects. Synthetic spaces and projects only.
const hex = (seed: string) => seed.repeat(64).slice(0, 64)
const named = (id: string, space: string): PersonalProject => ({ project_id: id, personal_space_id: space, profile: { name: `Synthetic ${id}` } })
const temporary = (seed: string, space: string): PersonalProject => ({
  project_id: `temporary-${hex(seed)}`, personal_space_id: space, scope_type: 'temporary', profile: { name: '临时会话 / Temporary session' },
})

function choices(options: { personalProjectsOnly: boolean; showTemporary: boolean }) {
  return useSpaceChoices({
    personalProjectsOnly: options.personalProjectsOnly,
    spaceId: computed(() => 'space-a'), projectId: computed(() => null), scope: computed((): KnowledgeScope => 'personal'),
    projectListingOptions: computed(() => ({ showTemporary: options.showTemporary, selectedProjectId: null })),
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  useConsoleStore().state = {
    mode: 'connected', activePersonalSpaceId: 'space-a',
    personalSpaces: [{ id: 'space-a', name: 'A' }, { id: 'space-b', name: 'B' }],
    personalProjects: [named('alpha', 'space-a'), temporary('1', 'space-a'), temporary('1', 'space-b'), named('beta', 'space-b')],
    projects: [{ id: 'team-1', name: 'Team', providerUrl: 'http://127.0.0.1:1' }], subscriptions: [],
  } as never
})

describe('graph toolbar space choices', () => {
  it('keeps each personal space with its named projects, then team projects, and folds temporary ones under 临时项目', () => {
    const { spaceSelectOptions } = choices({ personalProjectsOnly: false, showTemporary: true })
    const options = spaceSelectOptions.value
    expect(options.filter(option => !option.group).map(option => option.label)).toEqual([
      expect.stringContaining('A'), expect.stringContaining('Synthetic alpha'),
      expect.stringContaining('B'), expect.stringContaining('Synthetic beta'), expect.stringContaining('Team'),
    ])
    const folded = options.filter(option => option.group === '临时项目')
    // The same ID in two spaces gets two numbers, each still choosing its own space's project.
    expect(folded.map(option => option.label)).toEqual(['#11111111@space-a', '#11111111@space-b'])
    expect(folded.map(option => JSON.parse(option.value))).toEqual([
      ['personal', 'space-a', `temporary-${hex('1')}`], ['personal', 'space-b', `temporary-${hex('1')}`],
    ])
  })

  it('still hides temporary projects while the 临时项目 switch is off', () => {
    const { spaceSelectOptions } = choices({ personalProjectsOnly: true, showTemporary: false })
    expect(spaceSelectOptions.value.some(option => option.group)).toBe(false)
    expect(spaceSelectOptions.value.some(option => option.label.includes('Team'))).toBe(false)
  })
})
