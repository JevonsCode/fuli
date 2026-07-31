import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deleteJson = vi.hoisted(() => vi.fn())
const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ deleteJson, getJson, postJson }))

import { useConsoleStore } from '@/stores/console'
import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import PublicProjectsPage from './PublicProjectsPage.vue'

describe('PublicProjectsPage', () => {
  beforeEach(() => {
    deleteJson.mockReset()
    deleteJson.mockResolvedValue({})
    getJson.mockReset()
    getJson.mockImplementation((url: string) =>
      url.includes('/releases?')
        ? Promise.resolve({
            releases: [{
              version: 'v1.0.0',
              update_summary: '首次发布',
              published_at: '2026-07-31T00:00:00Z',
            }],
          })
        : Promise.resolve({
            relations: [{
              id: 'relation-1',
              source_project_id: 'project-a',
              target_project_id: 'project-b',
              relation_type: 'PART_OF',
              status: 'active',
            }],
          }),
    )
    postJson.mockReset()
    postJson.mockResolvedValue({})
  })

  it('keeps project details, hierarchy creation, and exact-name deletion in Vue', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'connected',
      activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      personalProjects: [],
      providers: {
        personal: { status: 'ready' },
        workspaces: [{ status: 'ready', providerUrl: 'https://provider.example' }],
      },
      projects: [
        {
          id: 'project-a',
          name: '项目 A',
          providerUrl: 'https://provider.example',
          role: 'maintainer',
          can_manage: true,
          current_release: {
            version: 'v1.0.0',
            published_at: '2026-07-31T00:00:00Z',
          },
        },
        {
          id: 'project-b',
          name: '项目 B',
          providerUrl: 'https://provider.example',
          role: 'reader',
        },
      ],
      subscriptions: [],
    }
    const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(undefined)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/knowledge/:scope/:spaceId/:mode', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    await router.isReady()
    const wrapper = mount(PublicProjectsPage, {
      global: {
        plugins: [pinia, router],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })

    const cards = wrapper.findAll('.project-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('查看详情')
    expect(cards[0].text()).toContain('v1.0.0')

    await cards[0].get('.primary-action').trigger('click')
    await flushPromises()
    expect(wrapper.get('.project-dialog-shell').text()).toContain('首次发布')
    expect(wrapper.get('.project-dialog-shell').text()).toContain('PART_OF')

    await wrapper.get('.relation-section-toolbar .primary-action').trigger('click')
    await wrapper.get('[aria-label="关系来源项目"]').setValue('project-a')
    await wrapper.get('[aria-label="项目关系类型"]').setValue('PART_OF')
    await wrapper.get('[aria-label="关系目标项目"]').setValue('project-b')
    expect(wrapper.get('.compact-relation-preview').text()).toContain(
      '项目 A 属于 项目 B',
    )
    await wrapper.get('.compact-relation-form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/project-relations', {
      sourceProjectId: 'project-a',
      targetProjectId: 'project-b',
      providerUrl: 'https://provider.example',
      relationType: 'PART_OF',
      note: null,
    })
    expect(store.feedback?.message).toContain('等待父项目确认')

    await cards[0].get('.management-action').trigger('click')
    const deletionDialogs = wrapper.findAll('.project-dialog')
    const deletionDialog = deletionDialogs.at(-1)!
    expect(deletionDialog.text()).toContain('输入完整项目名称')
    expect(deletionDialog.get('.reject').attributes()).toHaveProperty('disabled')
    await deletionDialog.get('input').setValue('项目 A')
    expect(deletionDialog.get('.reject').attributes('disabled')).toBeUndefined()
    await deletionDialog.get('.reject').trigger('click')
    await flushPromises()

    expect(deleteJson).toHaveBeenCalledWith(
      '/api/projects/project-a?providerUrl=https%3A%2F%2Fprovider.example',
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
