import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import type { ProjectAgentRecord } from '@/types'
import AgentHeaderTags from './AgentHeaderTags.vue'

const agent = { agentId: 'alpha', employeeNumber: '000004', occupation: { role: 'design', tags: [] }, profile: { status: 'active' } } as unknown as ProjectAgentRecord
const resize: Array<() => void> = []

async function setup(rowWidth: number, occupationKeys: string[]) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(60)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(rowWidth)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)', component: { template: '<div />' } }] })
  const wrapper = mount(AgentHeaderTags, { props: { agent, occupationKeys }, global: { plugins: [router] } })
  resize.forEach(notify => notify())
  await flushPromises()
  return wrapper
}

describe('AgentHeaderTags', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly notify: () => void) { resize.push(() => this.notify()) }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resize.length = 0 })

  it('shows every tag and no more-chip when the row has room', async () => {
    const wrapper = await setup(600, ['design', 'testing'])
    expect(wrapper.findAll('.agent-header-tag.is-folded')).toHaveLength(0)
    expect(wrapper.get('[data-tags-more]').classes()).toContain('is-idle')
  })

  it('folds what does not fit behind the more-chip, the number and status staying', async () => {
    const wrapper = await setup(260, ['design', 'testing', 'writing', 'data'])
    expect(wrapper.findAll('.agent-header-tag.is-folded')).toHaveLength(3)
    expect(wrapper.get('[data-tags-more]').classes()).not.toContain('is-idle')
    expect(wrapper.text()).toContain('FLA 000004')
  })
})
