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
import ExternalKnowledgeSettings from './ExternalKnowledgeSettings.vue'

describe('ExternalKnowledgeSettings', () => {
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
    const wrapper = mount(ExternalKnowledgeSettings, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: { ...optionSelectStubs },
      },
    })
    await flushPromises()

    expect(wrapper.findAll('.external-binding-row')).toHaveLength(2)
    expect(wrapper.text()).toContain('2 个连接')
    expect(wrapper.get('.external-create-action').text()).toBe('添加连接')
    expect(wrapper.get('.external-create-action').attributes('data-variant')).toBe('default')
    expect(wrapper.get('.external-create-action-icon').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-testid="external-knowledge-help"]').attributes()).toMatchObject({
      href: 'https://github.com/JevonsCode/fuli/blob/main/docs/external-knowledge.zh-CN.md#connect-external-knowledge',
      target: '_blank',
      rel: 'noreferrer',
    })
    expect(wrapper.findAll('.external-binding-target-chip').map((chip) => chip.text())).toContain(
      'Project B · 仅实时',
    )
    // With connections listed, the form waits for 添加连接; the opener then makes way for it.
    expect(wrapper.get<HTMLElement>('[data-external-connect-form]').element.style.display).toBe('none')
    await wrapper.get('[data-external-connect-open]').trigger('click')
    expect(wrapper.get<HTMLElement>('[data-external-connect-form]').element.style.display).toBe('')
    expect(wrapper.find('[data-external-connect-open]').exists()).toBe(false)
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
      'https://github.com/JevonsCode/fuli/blob/main/docs/external-knowledge.md#connect-external-knowledge',
    )
    wrapper.unmount()
  })
})
