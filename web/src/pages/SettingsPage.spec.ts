import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import SettingsPage from './SettingsPage.vue'

const configured = {
  version: 1 as const,
  ports: {
    console: 2727,
    personalProvider: 8787,
    personalNeo4jHttp: 8060,
    personalNeo4jBolt: 7687,
    workspaceProvider: 8788,
    workspaceNeo4jHttp: 7475,
    workspaceNeo4jBolt: 7688,
  },
  lanAccess: false,
  resourceRefreshSeconds: 5 as const,
}

describe('SettingsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows real resource data, personal ports, and the public-service roadmap', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = {
      mode: 'personal_only',
      personalSpaces: [],
      projects: [],
      subscriptions: [],
      capturePolicy: { enabled: true },
      agentAccessPolicy: { enabled: true },
    }
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === '/api/system/settings' && init?.method === 'PUT') {
        const next = JSON.parse(String(init.body))
        return Response.json({ configured: next, active: configured, restartRequired: true })
      }
      if (url === '/api/system/settings') {
        return Response.json({ configured, active: configured, restartRequired: false })
      }
      if (url === '/api/system/resources') {
        return Response.json({
          sampledAt: '2026-08-01T10:00:00.000Z',
          status: 'ready',
          memory: {
            usedBytes: 1_073_741_824,
            hostTotalBytes: 16_000_000_000,
            hostFreeBytes: 8_000_000_000,
            complete: true,
            components: [
              { id: 'console', label: 'Management service', status: 'ready', bytes: 40_000_000 },
              { id: 'personalNeo4j', label: 'Personal Neo4j', status: 'ready', bytes: 900_000_000 },
            ],
          },
          disk: {
            usedBytes: 2_700_000_000,
            hostTotalBytes: 500_000_000_000,
            hostFreeBytes: 200_000_000_000,
            complete: true,
            measuredAt: '2026-08-01T10:00:00.000Z',
            temporaryBytes: 800_000_000,
            components: [
              { id: 'neo4jData', label: 'Neo4j data', status: 'ready', bytes: 500_000_000 },
            ],
          },
          exclusions: ['browser-tab-memory'],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))

    const wrapper = mount(SettingsPage, { global: { plugins: [pinia] } })
    await flushPromises()

    expect(wrapper.text()).toContain('资源占用')
    expect(wrapper.text()).toContain('1.00 GiB')
    expect(wrapper.text()).toContain('个人 Neo4j')
    expect(wrapper.text()).toContain('硬盘更新于')
    expect(wrapper.findAll('.port-grid input')).toHaveLength(4)
    expect(wrapper.get('.development-section').text()).toContain('开发中')
    expect(wrapper.get('.development-section').text()).toContain('fuli-server')
    expect(wrapper.find('.save-bar').exists()).toBe(false)
    expect(wrapper.findAll('.select-row > select')).toHaveLength(0)
    expect(wrapper.findAll('.settings-select [role="combobox"]')).toHaveLength(2)

    const refreshSelect = wrapper.get('[data-select-id="settings-refresh-interval"]')
    await refreshSelect.get('[role="combobox"]').trigger('click')
    const tenSecondOption = refreshSelect
      .findAll('[role="option"]')
      .find((option) => option.text() === '10 秒')
    expect(tenSecondOption).toBeDefined()
    await tenSecondOption?.trigger('click')

    await wrapper.get('input[type="number"]').setValue(3030)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const savedRequest = requests.find(({ init }) => init?.method === 'PUT')
    expect(JSON.parse(String(savedRequest?.init?.body)).ports.console).toBe(3030)
    expect(JSON.parse(String(savedRequest?.init?.body)).resourceRefreshSeconds).toBe(10)
    expect(wrapper.get('.settings-top-status').text()).toContain('设置已保存')
    expect(wrapper.text()).toContain('需要重启')
    wrapper.unmount()
  })
})
