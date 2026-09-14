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

  it('keeps the latest project details when requests resolve out of order', async () => {
    const pending: Array<{
      url: string
      resolve: (value: unknown) => void
    }> = []
    getJson.mockImplementation((url: string) => new Promise<unknown>((resolve) => {
      pending.push({ url, resolve })
    }))

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
          role: 'reader',
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
    const router = await readyRouter()
    const wrapper = mount(PublicProjectsPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })

    const cards = wrapper.findAll('.project-card')
    await cards[0].get('.primary-action').trigger('click')
    await flushPromises()
    expect(pending.map(({ url }) => url)).toEqual([
      expect.stringContaining('/api/projects/project-a/releases'),
      expect.stringContaining('/api/project-relations'),
    ])

    await wrapper
      .get('dialog[aria-labelledby="public-project-details-title"] button')
      .trigger('click')
    await flushPromises()
    await cards[1].get('.primary-action').trigger('click')
    await flushPromises()

    pending[2]?.resolve({
      releases: [{ version: 'B-release', update_summary: 'B 版本', published_at: '2026-08-01' }],
    })
    pending[3]?.resolve({
      relations: [{
        id: 'relation-b',
        source_project_id: 'project-b',
        target_project_id: 'project-b-target',
        relation_type: 'DEPENDS_ON',
        status: 'active',
      }],
    })
    await flushPromises()

    const details = wrapper.get('dialog[aria-labelledby="public-project-details-title"]')
    expect(details.text()).toContain('B-release')
    expect(details.text()).toContain('DEPENDS_ON')

    pending[0]?.resolve({
      releases: [{ version: 'A-release', update_summary: 'A 版本', published_at: '2026-08-01' }],
    })
    pending[1]?.resolve({
      relations: [{
        id: 'relation-a',
        source_project_id: 'project-a',
        target_project_id: 'project-a-target',
        relation_type: 'PART_OF',
        status: 'active',
      }],
    })
    await flushPromises()

    expect(details.text()).toContain('B-release')
    expect(details.text()).not.toContain('A-release')
    expect(details.text()).not.toContain('PART_OF')
    wrapper.unmount()
  })

  it('opens public project dialogs as modal and restores focus after Escape', async () => {
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
      projects: [{
        id: 'project-a',
        name: '项目 A',
        providerUrl: 'https://provider.example',
        role: 'maintainer',
        can_manage: true,
      }],
      subscriptions: [],
    }
    const router = await readyRouter()
    const wrapper = mount(PublicProjectsPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })

    const detailsTrigger = wrapper.get('.project-card .primary-action')
    ;(detailsTrigger.element as HTMLElement).focus()
    await detailsTrigger.trigger('click')
    await flushPromises()
    const details = wrapper.get('dialog[aria-labelledby="public-project-details-title"]')
    expect((details.element as HTMLDialogElement).open).toBe(true)
    expect(document.activeElement).toBe(details.get('button').element)

    await details.trigger('cancel')
    await flushPromises()
    expect(document.activeElement).toBe(detailsTrigger.element)

    const deletionTrigger = wrapper.get('.project-card .management-action')
    ;(deletionTrigger.element as HTMLElement).focus()
    await deletionTrigger.trigger('click')
    await flushPromises()
    const deletion = wrapper.get('dialog[aria-labelledby="public-project-deletion-title"]')
    expect((deletion.element as HTMLDialogElement).open).toBe(true)
    expect(document.activeElement).toBe(deletion.get('input').element)

    await deletion.trigger('cancel')
    await flushPromises()
    expect(document.activeElement).toBe(deletionTrigger.element)
    wrapper.unmount()
  })

  it('gates unsupported workspace operations per provider without affecting Graphiti', async () => {
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
        workspaces: [
          {
            status: 'ready',
            providerUrl: 'https://graphiti.example',
            protocol: 'graphiti-v1',
          },
          {
            status: 'ready',
            providerUrl: 'https://fuli-workspace.example',
            protocol: 'fuli-workspace-v1',
          },
        ],
      },
      projects: [
        {
          id: 'graphiti-project',
          name: 'Graphiti 项目',
          providerUrl: 'https://graphiti.example',
          role: 'maintainer',
          can_manage: true,
          current_release: {
            version: 'graphiti-v1',
            published_at: '2026-08-01',
          },
        },
        {
          id: 'fuli-workspace-project',
          name: 'Workspace 项目',
          providerUrl: 'https://fuli-workspace.example',
          role: 'maintainer',
          can_manage: true,
          current_release: {
            version: 'must-not-display',
            published_at: '2026-08-01',
          },
        },
      ],
      subscriptions: [],
    }
    const router = await readyRouter()
    const wrapper = mount(PublicProjectsPage, {
      global: {
        plugins: [pinia, router],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })

    const cards = wrapper.findAll('.project-card')
    const graphitiCard = cards.find((card) => card.text().includes('Graphiti 项目'))!
    const fuliCard = cards.find((card) => card.text().includes('Workspace 项目'))!
    expect(graphitiCard.find('.management-action').exists()).toBe(true)
    expect(fuliCard.find('.management-action').exists()).toBe(false)
    expect(fuliCard.find('.project-release-meta').exists()).toBe(false)

    await fuliCard.get('.primary-action').trigger('click')
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    expect(wrapper.get('dialog[aria-labelledby="public-project-details-title"]').text())
      .toContain('该服务不提供版本记录或项目关系')
    expect(wrapper.find('.project-detail-columns').exists()).toBe(false)

    await wrapper
      .get('dialog[aria-labelledby="public-project-details-title"] button')
      .trigger('click')
    await flushPromises()
    await graphitiCard.get('.primary-action').trigger('click')
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(getJson.mock.calls.every(([url]) =>
      url.includes('graphiti-project') || url.includes('projectId=graphiti-project')))
      .toBe(true)
    expect(wrapper.get('dialog[aria-labelledby="public-project-details-title"]').text())
      .toContain('首次发布')

    const addRelation = wrapper.get('.relation-section-toolbar .primary-action')
    expect(addRelation.attributes('disabled')).toBeUndefined()
    await addRelation.trigger('click')
    const relationSource = wrapper.get('[aria-label="关系来源项目"]')
    expect(relationSource.findAll('option').map((option) => option.attributes('value')))
      .toContain('graphiti-project')
    expect(relationSource.findAll('option').map((option) => option.attributes('value')))
      .not.toContain('fuli-workspace-project')
  })
})

async function readyRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/knowledge/:scope/:spaceId/:mode', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  return router
}
