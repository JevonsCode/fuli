import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.fn()
const putJson = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(),
  getJson: (url: string) => getJson(url), putJson: (url: string, body: unknown) => putJson(url, body) }))

import { employeeAvatarUrl } from '@/features/employees/avatars'
import { setLocale } from '@/i18n'
import MeAvatar from './MeAvatar.vue'
import PersonHomeHeader from './PersonHomeHeader.vue'

// The person's own home (「我」). Synthetic names, styles and pictures only.
const ports = { console: 1, personalProvider: 2, personalNeo4jHttp: 3, personalNeo4jBolt: 4 }
const settings = (style: string, extra: Record<string, unknown> = {}) => ({
  configured: { version: 1, ports, lanAccess: false, graphRuntimeMode: 'native', resourceRefreshSeconds: 10, agentNamingStyle: style, ...extra },
  active: { version: 1, ports, lanAccess: false, graphRuntimeMode: 'native', resourceRefreshSeconds: 10, agentNamingStyle: style },
  restartRequired: false,
})
let space = 0
function serve(profile: unknown, saved = settings('用两个字的植物名')) {
  getJson.mockImplementation((url: string) => Promise.resolve(url.startsWith('/api/person-profile') ? profile : saved))
}
async function mountHeader() {
  const wrapper = mount(PersonHomeHeader, { props: { spaceId: `space-${++space}` }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('PersonHomeHeader', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    vi.useFakeTimers()
    getJson.mockReset()
    putJson.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('asks what FULI should call the person and saves the name after a pause, like Settings', async () => {
    serve({ name: '', look: { kind: 'default' }, updatedAt: null })
    putJson.mockImplementation((_url: string, body: { name: string }) => Promise.resolve({ name: body.name, look: { kind: 'default' }, updatedAt: 'x' }))
    const wrapper = await mountHeader()
    expect(wrapper.text()).toContain('FULI 怎么称呼你？')
    const field = wrapper.get<HTMLInputElement>('[data-person-name]')
    expect(field.attributes('maxlength')).toBe('32')
    await field.setValue('  Synthetic  ')
    expect(putJson).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/person-profile', { personalSpaceId: `space-${space}`, name: 'Synthetic' })
    expect(document.body.querySelector('[data-settings-save-capsule]')?.textContent).toContain('已自动保存')
    wrapper.unmount()
  })

  it('shows the name the person saved, and the neutral 「我」 face until they choose a picture', async () => {
    serve({ name: 'Synthetic', look: { kind: 'default' }, updatedAt: 'x' })
    const wrapper = await mountHeader()
    expect(wrapper.get<HTMLInputElement>('[data-person-name]').element.value).toBe('Synthetic')
    const trigger = wrapper.get('[data-person-avatar-trigger]')
    expect(trigger.find('[data-me-avatar-face]').text()).toBe('我')
    expect(trigger.find('img').exists()).toBe(false)
    wrapper.unmount()
  })

  it('draws a chosen look, serves an uploaded picture by its version, and falls back when it cannot load', async () => {
    serve({ name: '', look: { kind: 'image', imageVersion: 'abcdef0123456789' }, updatedAt: 'x' })
    const wrapper = await mountHeader()
    const avatar = wrapper.findComponent(MeAvatar)
    const picture = avatar.get('img')
    expect(picture.attributes('src')).toBe(`/api/person-profile/image?personalSpaceId=space-${space}&v=abcdef0123456789`)
    await picture.trigger('error')
    expect(avatar.find('img').exists()).toBe(false)
    expect(avatar.get('[data-me-avatar-face]').text()).toBe('我')
    wrapper.unmount()

    serve({ name: '', look: { kind: 'generated', seed: 'synthetic-seed' }, updatedAt: 'x' })
    const drawn = await mountHeader()
    expect(drawn.findComponent(MeAvatar).get('img').attributes('src')).toMatch(/^data:image\/svg\+xml/)
    drawn.unmount()
  })

  it('a picture this console cannot read leaves the face and keeps the name field closed', async () => {
    getJson.mockImplementation((url: string) => url.startsWith('/api/person-profile')
      ? Promise.reject(Object.assign(new Error('local_user_only'), { status: 403 })) : Promise.resolve(settings('')))
    const wrapper = await mountHeader()
    expect(wrapper.get('[data-me-avatar-face]').text()).toBe('我')
    expect(wrapper.get('[data-person-name]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-person-avatar-trigger]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('holds the FLA naming preference moved from Settings, in front of Bole, and saves only the style', async () => {
    serve({ name: '', look: { kind: 'default' }, updatedAt: null }, settings('用两个字的植物名', { lanAccess: true }))
    putJson.mockImplementation((_url: string, body: unknown) => Promise.resolve({ configured: body, active: body, restartRequired: false }))
    const wrapper = await mountHeader()
    const naming = wrapper.get('[data-person-naming]')
    expect(naming.text()).toContain('FLA 取名偏好')
    expect(naming.text()).toContain('Bole 按这个风格给新 FLA 取名')
    expect(naming.get('[data-person-naming-bole]').attributes('src')).toBe(employeeAvatarUrl('employee.bole'))
    const field = naming.get<HTMLTextAreaElement>('[data-agent-naming-style]')
    expect(field.element.value).toBe('用两个字的植物名')

    await field.setValue('像北欧神话里的名字')
    await vi.advanceTimersByTimeAsync(600)
    await flushPromises()
    expect(putJson).toHaveBeenCalledTimes(1)
    const [url, body] = putJson.mock.calls[0] as [string, { agentNamingStyle: string; lanAccess: boolean; resourceRefreshSeconds: number }]
    expect(url).toBe('/api/system/settings')
    expect(body.agentNamingStyle).toBe('像北欧神话里的名字')
    // A restart setting saved but not applied stays as FULI runs now; the rest is kept.
    expect(body.lanAccess).toBe(false)
    expect(body.resourceRefreshSeconds).toBe(10)

    await naming.get('[data-person-naming-details]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-person-naming-dialog]')?.textContent).toContain('负责招聘的 Agent')
    wrapper.unmount()
  })
})
