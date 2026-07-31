import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import LocaleSwitcher from './LocaleSwitcher.vue'

describe('LocaleSwitcher', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('changes the interface locale without translating technical labels', async () => {
    const wrapper = mount(LocaleSwitcher)

    expect(wrapper.get('button[lang="zh-CN"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('button[lang="en-US"]').trigger('click')

    expect(wrapper.get('button[lang="en-US"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Interface language')
  })
})
