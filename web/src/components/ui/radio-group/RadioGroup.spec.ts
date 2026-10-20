import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { RadioGroup, RadioGroupItem } from '.'

function mountGroup(options: { disabled?: boolean } = {}) {
  const value = ref('daily')
  const Harness = defineComponent(() => () => h(RadioGroup, {
    'modelValue': value.value,
    'onUpdate:modelValue': (next: unknown) => { value.value = next as string },
    'aria-label': '频率',
    'disabled': options.disabled,
  }, () => ['daily', 'weekly', 'monthly'].map(option => h(RadioGroupItem, { 'value': option, 'aria-label': option }))))
  return { wrapper: mount(Harness, { attachTo: document.body }), value }
}

describe('RadioGroup', () => {
  it('renders a named radiogroup whose checked item shows the dot', () => {
    const { wrapper } = mountGroup()
    const group = wrapper.get('[role="radiogroup"]')
    expect(group.attributes()).toMatchObject({ 'data-slot': 'radio-group', 'aria-label': '频率' })
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map(radio => radio.attributes('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(radios[0].find('[data-slot="radio-group-indicator"]').exists()).toBe(true)
    expect(radios[1].find('[data-slot="radio-group-indicator"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('updates v-model on click', async () => {
    const { wrapper, value } = mountGroup()
    await wrapper.findAll('[role="radio"]')[2].trigger('click')
    expect(value.value).toBe('monthly')
    expect(wrapper.findAll('[role="radio"]')[2].attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('moves focus and selection with the arrow keys', async () => {
    const { wrapper, value } = mountGroup()
    await flushPromises()
    const [daily, weekly] = wrapper.findAll('[role="radio"]')
    expect(wrapper.get('[role="radiogroup"]').attributes('tabindex')).toBe('0')
    ;(daily.element as HTMLElement).focus()
    await flushPromises()
    expect(daily.attributes('tabindex')).toBe('0')
    expect(weekly.attributes('tabindex')).toBe('-1')
    await daily.trigger('keydown', { key: 'ArrowDown' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await flushPromises()
    expect(document.activeElement).toBe(weekly.element)
    expect(value.value).toBe('weekly')
    wrapper.unmount()
  })

  it('does not change while disabled', async () => {
    const { wrapper, value } = mountGroup({ disabled: true })
    const weekly = wrapper.findAll('[role="radio"]')[1]
    expect(weekly.attributes('disabled')).toBeDefined()
    await weekly.trigger('click')
    expect(value.value).toBe('daily')
    wrapper.unmount()
  })
})
