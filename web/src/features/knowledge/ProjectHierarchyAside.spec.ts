import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import ProjectHierarchyAside from './ProjectHierarchyAside.vue'

describe('ProjectHierarchyAside', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('makes the parent relationship explicit and keeps it outside the graph', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(ProjectHierarchyAside, {
      props: {
        activeProjectName: '活动承接',
        spaceId: 'space-1',
        parents: [{
          projectId: 'hotel-theme',
          name: '酒店主题',
          summary: '上级项目',
          nodeId: 'node-1',
          relationId: 'relation-1',
        }],
      },
      global: { plugins: [router] },
    })

    expect(wrapper.text()).toContain('活动承接 属于以下项目')
    expect(wrapper.text()).toContain('酒店主题')
    expect(wrapper.get('a').attributes('href'))
      .toBe('/personal/space-1/projects/hotel-theme/graph')
  })
})
