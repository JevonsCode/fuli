import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelRoleCard from './ModelRoleCard.vue'
import { checkModelRole, type ModelRoleView } from './model'

vi.mock('./model', async importOriginal => ({ ...await importOriginal<typeof import('./model')>(), checkModelRole: vi.fn() }))

const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()
const connected = (extra: Partial<ModelRoleView> = {}): ModelRoleView => ({ role: 'assistant', state: 'enabled', answeredBy: 'model_api',
  connection: { id: 'synthetic', protocol: 'openai_chat', endpointHost: 'model.test', model: 'synthetic-chat', secretRef: null }, ...extra })
const mountCard = (view: ModelRoleView) => mount(ModelRoleCard, { props: { view, locked: false, editing: false } })

describe('ModelRoleCard', () => {
  beforeEach(() => { vi.mocked(checkModelRole).mockReset() })

  it('without a model says what model is enough, and its action is 接入', () => {
    const wrapper = mountCard({ role: 'jefa', state: 'not_configured', answeredBy: 'current_session' })
    expect(wrapper.get('[data-model-use-advice]').text()).toBe('推荐小型聊天模型就够。')
    expect(wrapper.find('[data-model-role-health]').exists()).toBe(false)
    expect(wrapper.get('[data-model-role-edit]').text()).toBe('接入')
  })

  it('with a model says when it last answered instead of the recommendation', () => {
    const wrapper = mountCard(connected({ health: { status: 'ok', at: ago(2), reason: null } }))
    expect(wrapper.get('[data-model-use-state]').text()).toBe('已接上')
    expect(wrapper.get('[data-model-role-health]').text()).toBe('正常 · 上次回答 2小时前')
    expect(wrapper.find('[data-model-use-advice]').exists()).toBe(false)
    expect(wrapper.find('[data-model-failure]').exists()).toBe(false)
  })

  it('a model that did not answer says why, lifts the card, and tests the connection in place', async () => {
    vi.mocked(checkModelRole).mockResolvedValue({ ok: true, receipt: { status: 'completed', actualModel: 'synthetic-chat' } })
    const wrapper = mountCard(connected({ health: { status: 'failing', at: ago(3), reason: 'auth_failed' } }))
    expect(wrapper.get('[data-model-use-state]').text()).toBe('没回应')
    expect(wrapper.get('[data-model-use-state]').attributes('data-variant')).toBe('destructive')
    expect(wrapper.attributes('data-model-failing')).toBe('true')
    expect(wrapper.get('[data-model-failure-text]').text()).toBe('没回应：密钥不对 · 3小时前')
    // The actions are the same two, in the same place.
    expect(wrapper.findAll('footer button').map(button => button.text())).toEqual(['查看详情', '编辑'])
    await wrapper.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(checkModelRole).toHaveBeenCalledWith('assistant')
    expect(wrapper.get('[data-model-failure-text]').text()).toBe('连接正常，synthetic-chat 回答了。')
    expect(wrapper.emitted('checked')).toHaveLength(1)
  })

  it('a use that is off shows no failure: it makes no calls', () => {
    const wrapper = mountCard(connected({ state: 'disabled', health: { status: 'failing', at: ago(3), reason: 'auth_failed' } }))
    expect(wrapper.get('[data-model-use-state]').text()).toBe('已停用')
    expect(wrapper.find('[data-model-failure]').exists()).toBe(false)
  })
})
