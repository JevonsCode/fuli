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
    expect(wrapper.find('.model-power-dot').exists()).toBe(true)
    wrapper.unmount()
  })

  it('is lit on the model page, which is its own page beside 设置', async () => {
    answer(roles(['enabled']), { model: null, total: 0, done: 0, running: false })
    routeState.path = '/models'
    const wrapper = await mountButton()
    const link = wrapper.find('[data-model-power]')
    expect(link.classes()).toContain('is-active')
    expect(link.attributes('aria-current')).toBe('page')
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/models')
    wrapper.unmount()
  })
})
