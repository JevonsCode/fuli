import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deleteJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ deleteJson, postJson }))

import { useConsoleStore } from '@/stores/console'
import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import ConnectionsPage from './ConnectionsPage.vue'

describe('ConnectionsPage', () => {
  beforeEach(() => {
    deleteJson.mockReset()
    deleteJson.mockResolvedValue({})
    postJson.mockReset()
    postJson.mockResolvedValue({})
  })

  it('keeps local health separate from public status and manages explicit subscriptions', async () => {
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
      capabilities: { subscribeProject: true },
      projects: [
        {
          id: 'project-a',
          name: '项目 A',
          providerUrl: 'https://provider.example',
        },
        {
          id: 'project-b',
          name: '项目 B',
          providerUrl: 'https://provider.example',
        },
      ],
      subscriptions: [{
        project_id: 'project-a',
        provider_url: 'https://provider.example',
        project_name: '项目 A',
      }],
    }
    const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(undefined)
    const wrapper = mount(ConnectionsPage, {
      global: {
        plugins: [pinia],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })

    const cards = wrapper.findAll('.service-connection-card')
    expect(cards[0].text()).toContain('本地 Graphiti')
    expect(cards[0].text()).toContain('已连接')
    expect(cards[1].text()).toContain('公共服务')
    expect(cards[1].text()).toContain('1 个共享服务可用')

    await wrapper.get('[aria-label="团队共享项目"]').setValue(
      'https://provider.example::project-b',
    )
    await wrapper.get('.subscription-form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/subscriptions', {
      personalSpaceId: 'personal-1',
      projectId: 'project-b',
      providerUrl: 'https://provider.example',
      projectName: '项目 B',
    })

    await wrapper.get('.subscription-action').trigger('click')
    await flushPromises()
    expect(deleteJson).toHaveBeenCalledWith(
      '/api/subscriptions/project-a?personalSpaceId=personal-1'
      + '&providerUrl=https%3A%2F%2Fprovider.example',
    )
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
