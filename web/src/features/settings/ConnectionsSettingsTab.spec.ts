import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import type { ConsoleState, RuntimeSettings } from '@/types'
import ConnectionsSettingsTab from './ConnectionsSettingsTab.vue'

const settings = {
  version: 1, graphRuntimeMode: 'native', lanAccess: false, resourceRefreshSeconds: 5,
  ports: { console: 2727, personalProvider: 8787, personalNeo4jHttp: 8060, personalNeo4jBolt: 7687,
    workspaceProvider: 8788, workspaceNeo4jHttp: 7475, workspaceNeo4jBolt: 7688 },
} as unknown as RuntimeSettings

function mountTab(state: Partial<ConsoleState>) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [], ...state } as ConsoleState
  return mount(ConnectionsSettingsTab, {
    props: { form: structuredClone(settings), active: settings, pendingRestart: new Set<never>(), applying: false, applyError: '', fieldErrors: {} },
    global: { plugins: [pinia], stubs: { ExternalKnowledgeSettings: true, ConflictPolicyCard: true, PeerSettings: true } },
  })
}

describe('ConnectionsSettingsTab', () => {
  it('starts with the local graph service, then external knowledge, then the local network', () => {
    const wrapper = mountTab({ providers: { personal: { status: 'ready' }, workspaces: [] } } as never)
    const local = wrapper.get('[data-local-graph]')
    expect(local.text()).toContain('本地 Graphiti')
    expect(local.text()).toContain('已连接')
    expect(local.get('dl').text()).toContain('Neo4j')
    expect(local.classes()).toContain('settings-card')
    expect(wrapper.find('external-knowledge-settings-stub').exists()).toBe(true)
    // Without a project there is nothing to set a conflict policy for.
    expect(wrapper.find('conflict-policy-card-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('局域网访问')
    expect(wrapper.findAll('.port-grid input')).toHaveLength(4)
    expect(wrapper.find('peer-settings-stub').exists()).toBe(true)
    expect(wrapper.find('[data-settings-restart-notice]').exists()).toBe(false)
  })

  it('keeps console LAN access and the ports, and leaves out LAN pairing until it is shown', () => {
    const hidden = mountTab({ advancedAreas: { shown: [] } })
    expect(hidden.text()).toContain('局域网访问')
    expect(hidden.findAll('.port-grid input')).toHaveLength(4)
    expect(hidden.find('peer-settings-stub').exists()).toBe(false)
    hidden.unmount()
    const shownLan = mountTab({ advancedAreas: { shown: ['lan'] } })
    expect(shownLan.find('peer-settings-stub').exists()).toBe(true)
    shownLan.unmount()
  })

  it('offers the conflict policy once there are projects, and says when the graph service is down', () => {
    const wrapper = mountTab({ personalProjects: [{ project_id: 'project-a', personal_space_id: 'personal-1', profile: { name: 'A' } }] } as never)
    expect(wrapper.find('conflict-policy-card-stub').exists()).toBe(true)
    expect(wrapper.get('[data-local-graph]').attributes('data-status')).toBe('error')
    expect(wrapper.get('[data-local-graph]').text()).toContain('连接异常')
  })
})
