import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn() }))
const routeState = vi.hoisted(() => ({ path: '/' }))
vi.mock('vue-router', async (importOriginal) => ({ ...await importOriginal<typeof import('vue-router')>(), useRoute: () => routeState }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import ModelPowerButton from './ModelPowerButton.vue'

const role = (name: string, state: string) => ({ role: name, state, answeredBy: state === 'enabled' ? 'model_api' : 'current_session' })
const roles = (states: string[], state = 'valid') => ({ state, roles: states.map((s, i) => role(`r${i}`, s)) })

function answer(rolesPayload: unknown, semantic: unknown) {
  api.getJson.mockImplementation(async (url: string) => {
    if (url === '/api/model-backends/roles') return rolesPayload
    if (semantic === null) throw new Error('not found')
    return semantic
  })
}

async function mountButton() {
  setLocale('zh-CN')
  const wrapper = mount(ModelPowerButton, { global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

afterEach(() => { api.getJson.mockReset(); routeState.path = '/' })

describe('ModelPowerButton', () => {
  it('stays quiet when no model is connected, and points to the model page', async () => {
    answer(roles(['not_configured', 'not_configured']), null)
    const wrapper = await mountButton()
    const link = wrapper.get('[data-model-power]')
    expect(link.attributes('data-model-power')).toBe('off')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/models')
    expect(link.attributes('aria-label')).toContain('还没有接模型')
    wrapper.unmount()
  })

  it('lights up and counts the roles a model powers', async () => {
    answer(roles(['enabled', 'not_configured', 'enabled']), { total: 10, done: 4, running: false })
    const wrapper = await mountButton()
    expect(wrapper.get('[data-model-power]').attributes('data-model-power')).toBe('on')
    expect(wrapper.get('[data-model-power]').attributes('aria-label')).toContain('2')
    wrapper.unmount()
  })

  it('shows a filling ring while old knowledge is being indexed', async () => {
    answer(roles(['enabled']), { total: 40, done: 10, running: true })
    const wrapper = await mountButton()
    const link = wrapper.get('[data-model-power]')
    expect(link.attributes('data-model-power')).toBe('filling')
    expect(link.attributes('style')).toContain('--power-progress: 25%')
    expect(link.attributes('aria-label')).toContain('10/40')
    wrapper.unmount()
  })

  it('marks a configuration that cannot be read', async () => {
    answer(roles(['enabled'], 'invalid'), null)
    const wrapper = await mountButton()
    expect(wrapper.get('[data-model-power]').attributes('data-model-power')).toBe('problem')
    expect(wrapper.find('.model-power-split').exists()).toBe(false)
    wrapper.unmount()
  })

  it('turns red, without the signal effect, when a connected model failed its latest call', async () => {
    const payload = roles(['enabled', 'enabled']) as { roles: Array<Record<string, unknown>> }
    payload.roles[0] = { ...payload.roles[0], role: 'tonborg', health: { status: 'failing', at: '2026-11-06T00:00:00Z', reason: 'network' } }
    payload.roles[1] = { ...payload.roles[1], health: { status: 'ok', at: '2026-11-06T00:00:00Z', reason: null } }
    answer(payload, null)
    const wrapper = await mountButton()
    const link = wrapper.get('[data-model-power]')
    expect(link.attributes('data-model-power')).toBe('problem')
    expect(link.attributes('aria-label')).toContain('Tonborg')
    expect(wrapper.find('.model-power-split').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the signal effect only while a model powers FULI', async () => {
    answer(roles(['enabled']), { total: 0, done: 0, running: false })
    const on = await mountButton()
    expect(on.findAll('.model-power-split')).toHaveLength(2)
    on.unmount()
    answer(roles(['not_configured']), null)
    const off = await mountButton()
    expect(off.find('.model-power-split').exists()).toBe(false)
    off.unmount()
  })

  it('is lit on the model page, which is its own page beside 设置', async () => {
    answer(roles(['enabled']), { model: null, total: 0, done: 0, running: false })
    routeState.path = '/models'
    const wrapper = await mountButton()
    const link = wrapper.find('[data-model-power]')
    expect(link.classes()).toContain('is-active')
    expect(link.attributes('aria-current')).toBe('page')
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/models')
    expect(wrapper.find('[data-model-power-reticle]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('draws the targeting frame only on the model page', async () => {
    answer(roles(['enabled']), { model: null, total: 0, done: 0, running: false })
    routeState.path = '/settings'
    const wrapper = await mountButton()
    expect(wrapper.find('[data-model-power]').classes()).not.toContain('is-active')
    expect(wrapper.find('[data-model-power-reticle]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hovering shows each use with its model, and a failing one in plain words, with no native tooltip', async () => {
    const connection = (model: string) => ({ id: model, protocol: 'anthropic_messages', endpointHost: '192.0.2.1:6666', model, secretRef: 'synthetic' })
    answer({ state: 'valid', roles: [
      { role: 'assistant', state: 'enabled', answeredBy: 'model_api', connection: connection('synthetic-chat'), health: { status: 'ok' } },
      { role: 'tonborg', state: 'enabled', answeredBy: 'model_api', connection: connection('synthetic-judge'), health: { status: 'failing' } },
      { role: 'bole', state: 'not_configured', answeredBy: 'current_session' },
    ] }, null)
    setLocale('zh-CN')
    const wrapper = mount(ModelPowerButton, { global: { stubs: { RouterLink: RouterLinkStub,
      HeaderPeek: { template: '<div><slot name="trigger" /><div data-peek-body><slot /></div></div>' } } } })
    await flushPromises()
    expect(wrapper.get('[data-model-power]').attributes('title')).toBeUndefined()
    const rows = wrapper.findAll('[data-model-peek-role]').map(row => row.findAll('span').map(span => span.text()))
    expect(rows).toEqual([[expect.any(String), 'synthetic-chat'], [expect.any(String), '没回应']])
    expect(wrapper.get('[data-model-peek-status]').text()).toBe('1 项没回应')
    wrapper.unmount()
  })
})
