import { mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/team-work/useTeamWork', () => ({ useTeamWork: () => ({ state: ref('ready'), sheets: ref([]) }) }))

import { setLocale } from '@/i18n'
import type { ProjectAgentTaskRecord } from '@/types'
import WorkbenchFeed from './WorkbenchFeed.vue'

const task = (id: string, status: ProjectAgentTaskRecord['status']): ProjectAgentTaskRecord =>
  ({ taskId: id, personalProjectId: 'synthetic', title: `Synthetic ${id}`, status, participants: [] })
const idle = { loading: false, error: '', data: { items: [] }, updatedAt: null }

function mountFeed(running: number, done: number) {
  return mount(WorkbenchFeed, {
    props: {
      requests: [], requestsState: idle, requestTotal: 0, tasksState: idle,
      running: Array.from({ length: running }, (_, i) => task(`r${i}`, 'running')),
      done: Array.from({ length: done }, (_, i) => task(`d${i}`, 'completed')),
      title: (item: ProjectAgentTaskRecord) => item.title, agentName: () => 'Synthetic FLA', owner: () => 'Synthetic FLA',
      statusLabel: (status: string) => status, formatTime: () => 'now',
    } as never,
    global: { stubs: { RouterLink: RouterLinkStub, WidgetSlot: true, 'motion.span': { template: '<span><slot /></span>' } } },
  })
}

describe('WorkbenchFeed', () => {
  beforeEach(() => { setActivePinia(createPinia()); setLocale('zh-CN') })

  it('shows seven of each list and opens the rest from the head', async () => {
    const wrapper = mountFeed(9, 10)
    expect(wrapper.findAll('[data-workbench-pick]')).toHaveLength(7)
    expect(wrapper.findAll('[data-workbench-done] li')).toHaveLength(7)
    const more = wrapper.get('[data-workbench-more="done"]')
    expect(more.text()).toBe('更多 3')
    await more.trigger('click')
    expect(wrapper.findAll('[data-workbench-done] li')).toHaveLength(10)
    expect(wrapper.get('[data-workbench-more="done"]').text()).toBe('收起')
    await wrapper.get('[data-workbench-more="running"]').trigger('click')
    expect(wrapper.findAll('[data-workbench-pick]')).toHaveLength(9)
  })

  it('has no 更多 when a list fits', () => {
    const wrapper = mountFeed(3, 6)
    expect(wrapper.find('[data-workbench-more]').exists()).toBe(false)
  })
})
