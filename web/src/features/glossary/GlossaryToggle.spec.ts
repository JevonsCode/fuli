import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import GlossaryToggle from './GlossaryToggle.vue'
import { useGlossaryMode } from './glossary-mode'

afterEach(() => useGlossaryMode().reset())

describe('GlossaryToggle', () => {
  it('turns into a wide put-it-back strip while pinned and back into the small ⓘ', async () => {
    const wrapper = mount(GlossaryToggle)
    expect(wrapper.find('[data-glossary-return]').exists()).toBe(false)
    await wrapper.get('[data-glossary-toggle]').trigger('click')
    const strip = wrapper.get('[data-glossary-return]')
    expect(strip.text()).toBe('收回问号')
    expect(strip.attributes('aria-label')).toBe('关闭术语解释')
    await strip.trigger('click')
    expect(wrapper.find('[data-glossary-return]').exists()).toBe(false)
    expect(useGlossaryMode().pinned.value).toBe(false)
  })
})
