import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ProjectAgentRecord } from '@/types'
import AgentProfileSettings from './AgentProfileSettings.vue'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson }))
const mounted: Array<{ unmount: () => void }> = []
function agent(): ProjectAgentRecord { return {
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  agentId: 'alpha', personalSpaceId: 'space-a', personalProjectId: 'project-a', profile: {
    name: 'Aster', displayName: 'Synthetic Aster', responsibility: 'Review changes.', status: 'active',
    capabilities: ['review'], workKinds: ['verification'], initialPreferences: ['Concise summaries.'],
    allowedClients: ['codex', 'cursor'], occupationEmoji: '🔎',
    executorPolicy: { mode: 'flexible', lockedExecutorIds: [], preferredExecutorIds: ['runtime-a', 'runtime-b'] },
    defaultModelStrategy: { mode: 'deep', reasoningEffort: 'high', capabilityHints: ['testing'] },
    character: { judgment: 'Check evidence.', taste: 'Clear layouts.', personality: 'Patient.' }, expectations: 'Report failures.',
  },
} }
beforeEach(() => {
  setActivePinia(createPinia()); getJson.mockReset(); putJson.mockReset()
  getJson.mockResolvedValue([{ executorId: 'runtime-a', displayName: 'Synthetic runtime', registrationStatus: 'registered', permissionStatus: 'authorized', preflightStatus: 'passed', workspacePermission: true, healthRequired: false, healthStatus: 'unknown' }])
  putJson.mockImplementation(async (_url: string, payload: { profile: ProjectAgentRecord['profile'] }) => ({ ...agent(), profile: payload.profile }))
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))
async function setup(person = agent()) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/agents/space-a/alpha')
  const wrapper = mount(AgentProfileSettings, { props: { agent: person }, global: { plugins: [router] } })
  mounted.push(wrapper); await flushPromises(); return wrapper
}
describe('Agent profile settings integration', () => {
  it('saves character and expectations while preserving all other profile fields', async () => {
    const original = agent(), wrapper = await setup(original)
    const textareas = wrapper.findAll('textarea')
    await textareas[0]!.setValue('Explain test evidence.')
    await textareas[1]!.setValue('Verify assumptions.')
    await textareas[2]!.setValue('Prefer simple navigation.')
    await textareas[3]!.setValue('Direct and patient.')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    const profile = { ...original.profile, expectations: 'Explain test evidence.', character: { judgment: 'Verify assumptions.', taste: 'Prefer simple navigation.', personality: 'Direct and patient.' } }
    expect(putJson).toHaveBeenCalledWith('/api/project-agents', { personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: 'alpha', profile })
    expect(wrapper.emitted('saved')?.[0]?.[0]).toEqual({ ...original, profile })
    expect(original.profile.expectations).toBe('Report failures.')
    expect(wrapper.find('form').exists()).toBe(true)
  })

  it('keeps an executor lock immutable when editing user expectations', async () => {
    const original = agent()
    original.profile.executorPolicy = { mode: 'locked', lockedExecutorIds: ['runtime-a','runtime-b'], preferredExecutorIds: [] }
    const wrapper = await setup(original)
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.get('.agent-locked-platforms').text()).toContain('Synthetic runtime')
    expect(wrapper.get('.agent-locked-platforms').text()).toContain('runtime-b')
    expect(wrapper.get('.agent-locked-platforms').text()).not.toContain('自动选择')
    await wrapper.get('textarea').setValue('Keep the existing executor.')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(putJson.mock.calls[0]![1].profile.executorPolicy).toEqual(original.profile.executorPolicy)
  })

  it('does not emit a previous Agent save result after its props change', async () => {
    let finish!: (value: ProjectAgentRecord) => void
    putJson.mockReturnValue(new Promise<ProjectAgentRecord>(resolve => { finish = resolve }))
    const wrapper = await setup()
    await wrapper.get('form').trigger('submit')
    const next = { ...agent(), agentId: 'beta', personalSpaceId: 'space-b', profile: { ...agent().profile, expectations: 'Different space expectations.' } }
    await wrapper.setProps({ agent: next }); await flushPromises()
    finish(agent()); await flushPromises()
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Different space expectations.')
    expect(getJson).toHaveBeenLastCalledWith('/api/executors?personalSpaceId=space-b')
  })
})
