import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson: vi.fn() }))

import { useConsoleStore } from '@/stores/console'
import JudgmentPolicySettings from './JudgmentPolicySettings.vue'

describe('JudgmentPolicySettings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getJson.mockReset().mockResolvedValue({ mode: 'manual', quality: 'quality', client: 'codex', revision: 0, globalRevision: 0, inherited: false, personalProjectId: null })
  })

  it('passes only projects in the active personal space to the policy control', async () => {
    const store = useConsoleStore()
    store.state = {
      mode: 'connected',
      activePersonalSpaceId: 'space-a',
      personalSpaces: [{ id: 'space-a', name: '我' }, { id: 'space-b', name: 'Other' }],
      personalProjects: [
        { project_id: 'project-a', personal_space_id: 'space-a', profile: { name: '验收项目', sources: [], boundaries: [] } },
        { project_id: 'project-b', personal_space_id: 'space-b', profile: { name: '另一个项目', sources: [], boundaries: [] } },
      ],
      projects: [], subscriptions: [],
    }
    const wrapper = mount(JudgmentPolicySettings)
    await flushPromises()
    expect(wrapper.get('[data-select="judgment-project"]').text()).toContain('验收项目')
    expect(wrapper.get('[data-select="judgment-project"]').text()).not.toContain('另一个项目')
  })
})
