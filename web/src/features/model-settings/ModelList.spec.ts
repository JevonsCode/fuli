import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelList from './ModelList.vue'
import { checkModelRole, type ModelRoleView, type ModelRolesPayload } from './model'

vi.mock('./model', async importOriginal => ({ ...await importOriginal<typeof import('./model')>(), checkModelRole: vi.fn() }))

// Synthetic connections only.
const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()
const connection = (id: string) => ({ id, protocol: 'openai_chat' as const, endpointHost: 'model.test', model: `${id}-model`, secretRef: null })
const role = (name: ModelRoleView['role'], id: string, extra: Partial<ModelRoleView> = {}): ModelRoleView =>
  ({ role: name, state: 'enabled', answeredBy: 'model_api', connection: connection(id), ...extra })
const payload = (roles: ModelRoleView[]): ModelRolesPayload => ({ state: 'ok', error: null, revision: null, connections: {}, roles, operations: {} })
const row = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.get(`[data-model-connection-id="${id}"]`)

describe('ModelList', () => {
  beforeEach(() => { vi.mocked(checkModelRole).mockReset() })

  it('says for each connection whether it works now: the last answer, the failure with its reason, or never called', () => {
    const wrapper = mount(ModelList, { props: { payload: payload([
      role('assistant', 'good', { health: { status: 'ok', at: ago(2), reason: null } }),
      role('tonborg', 'bad', { health: { status: 'ok', at: ago(1), reason: null } }),
      role('jefa', 'bad', { health: { status: 'failing', at: ago(3), reason: 'auth_failed' } }),
      role('bole', 'new', { health: { status: 'unknown', at: null, reason: null } }),
    ]) } })
    expect(row(wrapper, 'good').get('[data-model-connection-health]').text()).toBe('连接正常 · 最近回答 2小时前')
    // One role on the connection failing is the connection's state.
    const bad = row(wrapper, 'bad').get('[data-model-connection-health]')
    expect(bad.text()).toBe('连接没回应：密钥不对 · 3小时前')
    expect(bad.attributes('data-model-connection-health')).toBe('failing')
    expect(bad.attributes('role')).toBe('alert')
    expect(row(wrapper, 'new').get('[data-model-connection-health]').text()).toBe('还没调用过')
  })

  it('tests a connection from its row through a use that is on, shows the answer in place and asks for a new read', async () => {
    let finish: (value: Awaited<ReturnType<typeof checkModelRole>>) => void = () => {}
    vi.mocked(checkModelRole).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const wrapper = mount(ModelList, { props: { payload: payload([
      role('jefa', 'shared', { state: 'disabled' }),
      role('tonborg', 'shared', { health: { status: 'failing', at: ago(3), reason: 'timeout' } }),
      role('assistant', 'other'),
    ]) } })
    const check = row(wrapper, 'shared').get('[data-model-connection-check]')
    expect(check.text()).toBe('测试连接')
    await check.trigger('click')
    expect(checkModelRole).toHaveBeenCalledWith('tonborg')
    expect(check.get('[role="status"]').attributes('aria-label')).toBe('正在测试 Tonborg 的模型')
    // One test at a time.
    expect(row(wrapper, 'other').get('[data-model-connection-check]').attributes('disabled')).toBeDefined()
    finish({ ok: true, receipt: { status: 'completed', actualModel: 'shared-model' } })
    await flushPromises()
    const health = row(wrapper, 'shared').get('[data-model-connection-health]')
    expect(health.text()).toBe('连接正常，shared-model 回答了。')
    expect(health.attributes('data-model-connection-health')).toBe('ok')
    expect(wrapper.emitted('checked')).toHaveLength(1)
  })

  it('shows why a test failed in the row, and does not test a connection whose uses are all off', async () => {
    vi.mocked(checkModelRole).mockResolvedValue({ ok: false, receipt: { status: 'failed', reason: 'auth_failed' } })
    const wrapper = mount(ModelList, { props: { payload: payload([role('assistant', 'on'), role('jefa', 'off', { state: 'disabled' })]) } })
    await row(wrapper, 'on').get('[data-model-connection-check]').trigger('click')
    await flushPromises()
    expect(row(wrapper, 'on').get('[data-model-connection-health]').text()).toBe('没有连上：密钥不对')
    expect(row(wrapper, 'on').get('[data-model-connection-health]').attributes('role')).toBe('alert')
    const off = row(wrapper, 'off').get('[data-model-connection-check]')
    expect(off.attributes('disabled')).toBeDefined()
    expect(off.attributes('title')).toBe('用它的用途都停用了，打开一个才能测试')
  })
})
