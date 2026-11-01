import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SettingsSaveCapsule from './SettingsSaveCapsule.vue'

const capsule = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-settings-save-capsule]')

describe('SettingsSaveCapsule', () => {
  it('shows nothing while there is nothing to say', () => {
    const wrapper = mount(SettingsSaveCapsule, { props: { state: 'idle' } })
    expect(capsule(wrapper).exists()).toBe(false)
  })

  it('names the save in progress with the shared inline loading', () => {
    const wrapper = mount(SettingsSaveCapsule, { props: { state: 'saving' } })
    expect(capsule(wrapper).attributes('data-state')).toBe('saving')
    expect(wrapper.get('.growth-loading--inline').attributes('aria-label')).toBe('正在保存设置…')
  })

  it('names an applied restart setting while FULI restarts', () => {
    const wrapper = mount(SettingsSaveCapsule, { props: { state: 'applying' } })
    expect(wrapper.get('.growth-loading--inline').attributes('aria-label')).toBe('正在应用设置并重启 FULI…')
  })

  it('says the settings saved themselves', () => {
    const wrapper = mount(SettingsSaveCapsule, { props: { state: 'saved' } })
    expect(capsule(wrapper).text()).toBe('已自动保存')
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
  })

  it('says why a save failed and offers a retry', async () => {
    const wrapper = mount(SettingsSaveCapsule, { props: { state: 'error', failure: 'Synthetic refusal' } })
    expect(wrapper.get('[role="alert"]').text()).toBe('保存失败 · Synthetic refusal')
    await wrapper.get('[data-settings-save-retry]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})
