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
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import { closeCombobox, openCombobox, setOption } from '@/test-support/option-pickers'
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
      capabilities: {
        browsePublicProjects: true,
        subscribeProject: true,
        publishProject: false,
        submitKnowledge: false,
        reviewProposals: false,
      },
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
        stubs: { ...optionSelectStubs },
      },
    })

    const cards = wrapper.findAll('.service-connection-card')
    expect(cards[0].text()).toContain('本地 Graphiti')
    expect(cards[0].text()).toContain('已连接')
    expect(cards[1].text()).toContain('公共服务')
    expect(cards[1].text()).toContain('1 个共享服务可用')
    expect(cards[1].text()).toContain('发现和订阅')
    expect(cards[1].text()).not.toContain('发布')
    expect(cards[1].text()).not.toContain('投稿')
    expect(cards[1].text()).not.toContain('审核')

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
    wrapper.unmount()
  })

  it('creates, retargets and syncs an MCP binding', async () => {
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
      return Promise.resolve([])
    })
    postJson.mockImplementation((url: string) => Promise.resolve(
      url.endsWith('/sync') ? { imported: 2 } : { id: 'binding-2' },
    ))
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
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: { ...optionSelectStubs, ConflictPolicyCard: true },
      },
    })
    await flushPromises()

    expect(wrapper.find('conflict-policy-card-stub').exists()).toBe(true)
    expect(wrapper.findAll('.external-binding-row')).toHaveLength(2)
    expect(wrapper.text()).toContain('2 个连接')
    expect(wrapper.get('.external-create-action').text()).toBe('添加连接')
    expect(wrapper.get('.external-create-action').attributes('data-variant')).toBe('default')
    expect(wrapper.get('.external-create-action-icon').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-testid="external-knowledge-help"]').attributes()).toMatchObject({
      href: 'https://github.com/JevonsCode/fuli/blob/main/README.zh-CN.md#connect-external-knowledge',
      target: '_blank',
      rel: 'noreferrer',
    })
    expect(wrapper.findAll('.external-binding-target-chip').map((chip) => chip.text())).toContain(
      'Project B · 仅实时',
    )
    await wrapper.get('[data-testid="external-name"]').setValue('Engineering docs')
    await openCombobox(wrapper.get('[data-select-id="external-projects"]'))
    await setOption(wrapper, 'project-b', true)
    await closeCombobox(wrapper.get('[data-select-id="external-projects"]'))
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
    await openCombobox(editor)
    await setOption(editor, 'project-b', false)
    await closeCombobox(editor)
    await editor.get('.external-binding-editor-actions [data-variant="default"]').trigger('click')
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

    setLocale('en-US', { persist: false })
    await flushPromises()
    expect(wrapper.get('[data-testid="external-knowledge-help"]').attributes('href')).toBe(
      'https://github.com/JevonsCode/fuli/blob/main/README.md#connect-external-knowledge',
    )
    wrapper.unmount()
  })

  it('submits a subscription once while its request is pending', async () => {
    const wrapper = mountPage()
    const store = useConsoleStore()
    let finishRefresh!: () => void
    vi.spyOn(store, 'refresh').mockImplementation(() => new Promise<void>((resolve) => { finishRefresh = resolve }))
    store.state = { ...store.state!, capabilities: { subscribeProject: true },
      projects: [{ id: 'shared-project', name: 'Synthetic shared project', providerUrl: 'https://provider.example' }] }
    let finish!: (value: unknown) => void
    postJson.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await flushPromises()
    await wrapper.get('.subscription-form select').setValue('https://provider.example::shared-project')
    await wrapper.get('.subscription-form').trigger('submit')
    await wrapper.get('.subscription-form').trigger('submit')
    expect(postJson).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.subscription-form button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.growth-loading--inline').text()).toBe('正在订阅公共项目…')
    finish({})
    await flushPromises()
    expect(wrapper.get('.growth-loading--inline').text()).toBe('正在读取项目订阅状态…')
    finishRefresh()
    await flushPromises()
    expect(wrapper.find('.growth-loading--inline').exists()).toBe(false)
    wrapper.unmount()
  })
})

function mountPage() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = {
    mode: 'personal_only', activePersonalSpaceId: 'personal-1',
    personalSpaces: [{ id: 'personal-1', name: 'Synthetic personal space' }],
    personalProjects: ['project-a', 'project-b'].map((id) => ({
      project_id: id, personal_space_id: 'personal-1', profile: { name: id },
    })),
    projects: [], subscriptions: [],
  }
  return mount(ConnectionsPage, { global: {
    plugins: [pinia], stubs: { ...optionSelectStubs, ConflictPolicyCard: true },
  } })
}
