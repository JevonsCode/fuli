import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { setPalettePreference } from '@/lib/palette-preference'
import DesignLabPanel from './DesignLabPanel.vue'
import { designLab, resetDesignLab } from './design-lab'

afterEach(() => {
  resetDesignLab()
  designLab.value.open = false
  setPalettePreference('jade')
  window.localStorage.clear()
})

describe('DesignLabPanel', () => {
  it('opens from the launcher and recolours the console from a palette choice', async () => {
    const wrapper = mount(DesignLabPanel)
    await wrapper.get('[data-design-lab-open]').trigger('click')
    expect(wrapper.find('[data-design-lab]').exists()).toBe(true)

    const gold = wrapper.findAll('[data-lab-palette] button').find(button => button.text().includes('复利金'))!
    await gold.trigger('click')
    expect(document.documentElement.dataset.palette).toBe('gold')
    expect(gold.attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('applies motion choices as document attributes and resets them', async () => {
    designLab.value.open = true
    const wrapper = mount(DesignLabPanel)
    await wrapper.findAll('[data-lab-transition] button').find(button => button.text() === '上浮')!.trigger('click')
    await wrapper.get('[data-lab-lift]').trigger('click')
    await nextTick()
    expect(document.documentElement.dataset.labTransition).toBe('rise')
    expect(document.documentElement.dataset.labLift).toBe('on')
    expect(JSON.parse(window.localStorage.getItem('fuli.lab')!)).toMatchObject({ transition: 'rise', cardLift: true })

    await wrapper.get('[data-design-lab-reset]').trigger('click')
    await nextTick()
    expect(document.documentElement.dataset.labTransition).toBeUndefined()
    expect(document.documentElement.dataset.labLift).toBeUndefined()
    await wrapper.get('[data-design-lab-close]').trigger('click')
    expect(wrapper.find('[data-design-lab]').exists()).toBe(false)
    wrapper.unmount()
  })
})
