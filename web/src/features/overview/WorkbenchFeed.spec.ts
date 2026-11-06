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

  it('shows seven of each list and links the rest to its own page', () => {
    const wrapper = mountFeed(9, 10)
    expect(wrapper.findAll('[data-workbench-pick]')).toHaveLength(7)
    expect(wrapper.findAll('[data-workbench-done] li')).toHaveLength(7)
    const more = (list: string) => wrapper.findAllComponents(RouterLinkStub).find(link => link.attributes('data-workbench-more') === list)!
    expect(more('done').text()).toBe('更多 3')
    expect(more('done').props('to')).toBe('/workbench/done')
    expect(more('running').text()).toBe('更多 2')
    expect(more('running').props('to')).toBe('/workbench/running')
    // Each card carries the name its page grows from.
    expect(wrapper.get('[data-workbench-done]').attributes('data-list-morph')).toBe('done')
    expect(wrapper.get('[data-workbench-running]').attributes('data-list-morph')).toBe('running')
  })

  it('has no 更多 when a list fits', () => {
    const wrapper = mountFeed(3, 6)
    expect(wrapper.find('[data-workbench-more]').exists()).toBe(false)
  })
})
