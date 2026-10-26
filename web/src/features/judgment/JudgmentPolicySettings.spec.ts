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

  it('sets only the active space\'s default; projects get their own setting elsewhere', async () => {
    const store = useConsoleStore()
    store.state = {
      mode: 'connected',
      activePersonalSpaceId: 'space-a',
      personalSpaces: [{ id: 'space-a', name: '我' }, { id: 'space-b', name: 'Other' }],
      personalProjects: [
        { project_id: 'project-a', personal_space_id: 'space-a', profile: { name: '验收项目', sources: [], boundaries: [] } },
      ],
      projects: [], subscriptions: [],
    }
    const wrapper = mount(JudgmentPolicySettings)
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/judgment/policy?personalSpaceId=space-a')
    expect(wrapper.find('[data-select="judgment-project"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('验收项目')
  })
})
