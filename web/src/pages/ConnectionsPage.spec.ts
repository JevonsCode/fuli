import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deleteJson = vi.hoisted(() => vi.fn())
const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ deleteJson, getJson, patchJson, postJson }))

import { useConsoleStore } from '@/stores/console'
import { setLocale } from '@/i18n'
import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import ConnectionsPage from './ConnectionsPage.vue'

describe('ConnectionsPage', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    deleteJson.mockReset()
    deleteJson.mockResolvedValue({})
    getJson.mockReset()
    getJson.mockResolvedValue([])
    patchJson.mockReset()
    patchJson.mockResolvedValue({})
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

  it('creates and syncs an MCP binding and persists the project conflict switch', async () => {
    getJson.mockImplementation((url: string) => {
      if (url === '/api/external-knowledge/connectors') {
        return Promise.resolve([
          { type: 'mcp', name: 'MCP', capabilities: ['sync', 'retrieve'] },
          { type: 'notion', name: 'Notion', capabilities: ['sync', 'retrieve'] },
          { type: 'feishu', name: '飞书 / Lark', capabilities: ['sync', 'retrieve'] },
          { type: 'custom', name: '自定义代码', capabilities: ['sync', 'retrieve'] },
        ])
      }
      if (url === '/api/external-knowledge/bindings') {
        return Promise.resolve([
          {
            id: 'binding-1',
            name: 'Product docs',
            connectorType: 'mcp',
            mode: 'hybrid',
            status: 'ready',
            target: { personalSpaceId: 'personal-1', personalProjectId: 'project-a' },
            sync: { lastSyncedAt: null },
            targets: [
              {
                id: 'binding-1',
                personalSpaceId: 'personal-1',
                personalProjectId: 'project-a',
                mode: 'hybrid',
                status: 'ready',
                sync: { lastSyncedAt: null },
              },
              {
                id: 'target-b',
                personalSpaceId: 'personal-1',
                personalProjectId: 'project-b',
                mode: 'live',
                status: 'ready',
                sync: { lastSyncedAt: null },
              },
            ],
          },
          {
            id: 'binding-2',
            name: 'Team handbook',
            connectorType: 'notion',
            mode: 'live',
            status: 'ready',
            target: { personalSpaceId: 'personal-1', personalProjectId: 'project-a' },
            sync: { lastSyncedAt: null },
          },
        ])
      }
      if (url.includes('/api/external-knowledge/conflict-policy')) {
        return Promise.resolve({ personalProjectId: 'project-a', mode: 'ask_human' })
      }
      return Promise.resolve([])
    })
    postJson.mockImplementation((url: string) => Promise.resolve(
      url.endsWith('/sync') ? { imported: 2 } : { id: 'binding-2' },
    ))
    patchJson.mockResolvedValue({ personalProjectId: 'project-a', mode: 'agent_decide' })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      personalProjects: [{
        project_id: 'project-a',
        personal_space_id: 'personal-1',
        profile: { name: 'Project A' },
      }, {
        project_id: 'project-b',
        personal_space_id: 'personal-1',
        profile: { name: 'Project B' },
      }],
      providers: { personal: { status: 'ready' }, workspaces: [] },
      projects: [],
      subscriptions: [],
    }
    const wrapper = mount(ConnectionsPage, {
      global: {
        plugins: [pinia],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })
    await flushPromises()

    expect(wrapper.findAll('.external-binding-row')).toHaveLength(2)
    expect(wrapper.text()).toContain('2 个连接')
    expect(wrapper.get('.external-create-action').text()).toBe('添加连接')
    expect(wrapper.get('.external-create-action').classes()).toContain('primary-action')
    expect(wrapper.get('.external-create-action-icon').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-testid="external-knowledge-help"]').attributes()).toMatchObject({
      href: 'https://github.com/JevonsCode/fuli/blob/main/README.zh-CN.md#connect-external-knowledge',
      target: '_blank',
      rel: 'noreferrer',
    })
    expect(wrapper.get('[data-testid="conflict-policy-help"]').attributes('href')).toBe(
      'https://github.com/JevonsCode/fuli/blob/main/README.zh-CN.md#external-knowledge-conflict-policy',
    )
    expect(wrapper.findAll('.external-binding-target-chip').map((chip) => chip.text())).toContain(
      'Project B · 仅实时',
    )
    await wrapper.get('[data-testid="external-name"]').setValue('Engineering docs')
    await wrapper.get('[data-select-id="external-projects"] .searchable-select-trigger').trigger('click')
    await wrapper.findAll('[data-select-id="external-projects"] [role="option"]')[1].trigger('click')
    await wrapper.get('[data-testid="mcp-url"]').setValue('https://mcp.example.test')
    await wrapper.get('[data-testid="mcp-token-env"]').setValue('MCP_READ_TOKEN')
    await wrapper.get('[data-testid="mcp-resource-prefix"]').setValue(
      'https://docs.example.test/',
    )
    await wrapper.get('.external-binding-form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/external-knowledge/bindings', {
      name: 'Engineering docs',
      connectorType: 'mcp',
      connectorConfig: {
        transport: 'http',
        url: 'https://mcp.example.test',
        tokenEnv: 'MCP_READ_TOKEN',
      },
      source: { resourceUriPrefix: 'https://docs.example.test/' },
      targets: [
        {
          personalSpaceId: 'personal-1',
          personalProjectId: 'project-a',
          mode: 'hybrid',
        },
        {
          personalSpaceId: 'personal-1',
          personalProjectId: 'project-b',
          mode: 'hybrid',
        },
      ],
    })

    await wrapper.findAll('.external-binding-actions')[0].findAll('button')[2].trigger('click')
    await flushPromises()
    const editor = wrapper.get('.external-binding-editor')
    await editor.get('.searchable-select-trigger').trigger('click')
    await editor.findAll('[role="option"]')[1].trigger('click')
    await editor.get('.external-binding-editor-actions .primary-action').trigger('click')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith(
      '/api/external-knowledge/bindings/binding-1/targets',
      {
        targets: [{
          personalSpaceId: 'personal-1',
          personalProjectId: 'project-a',
          mode: 'hybrid',
        }],
      },
    )

    await wrapper.get('.external-sync-action').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith(
      '/api/external-knowledge/bindings/binding-1/sync',
      {},
    )

    await wrapper.get('[aria-label="知识冲突处理"]').setValue('agent_decide')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith(
      '/api/external-knowledge/conflict-policy?personalProjectId=project-a',
      {
        personalSpaceId: 'personal-1',
        personalProjectId: 'project-a',
        mode: 'agent_decide',
      },
    )

    setLocale('en-US', { persist: false })
    await flushPromises()
    expect(wrapper.get('[data-testid="external-knowledge-help"]').attributes('href')).toBe(
      'https://github.com/JevonsCode/fuli/blob/main/README.md#connect-external-knowledge',
    )
    expect(wrapper.get('[data-testid="conflict-policy-help"]').attributes('href')).toBe(
      'https://github.com/JevonsCode/fuli/blob/main/README.md#external-knowledge-conflict-policy',
    )
  })
})
