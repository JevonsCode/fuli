import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '.'

const OPTIONS = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor', disabled: true },
]

function mountSelect(options: { initial?: string, disabled?: boolean } = {}) {
  const value = ref(options.initial)
  const Harness = defineComponent(() => () => h(Select, {
    'modelValue': value.value,
    'onUpdate:modelValue': (next: unknown) => { value.value = next as string },
    'disabled': options.disabled,
  }, () => [
    h(SelectTrigger, { 'aria-label': '执行者' }, () => h(SelectValue, { placeholder: '选择执行者' })),
    h(SelectContent, null, () => OPTIONS.map(option => h(SelectItem, { value: option.value, disabled: option.disabled }, () => option.label))),
  ]))
  return { wrapper: mount(Harness, { attachTo: document.body }), value }
}

function listbox() {
  return document.querySelector<HTMLElement>('[role="listbox"]')
}

describe('Select', () => {
  it('renders a named combobox trigger that shows the placeholder until a value is chosen', () => {
    const { wrapper } = mountSelect()
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.attributes()).toMatchObject({ 'data-slot': 'select-trigger', 'data-size': 'default', 'aria-label': '执行者', 'aria-expanded': 'false', 'type': 'button' })
    expect(trigger.attributes('data-placeholder')).toBeDefined()
    expect(trigger.text()).toContain('选择执行者')
    expect(listbox()).toBeNull()
    wrapper.unmount()
  })

  it('shows the chosen value from v-model', async () => {
    const { wrapper } = mountSelect({ initial: 'claude-code' })
    await flushPromises()
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.attributes('data-placeholder')).toBeUndefined()
    expect(trigger.text()).toContain('Claude Code')
    wrapper.unmount()
  })

  it('opens from the keyboard and updates v-model when an option is chosen', async () => {
    const { wrapper, value } = mountSelect({ initial: 'codex' })
    const trigger = wrapper.get('[role="combobox"]')
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    const options = [...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    expect(options.map(option => option.textContent?.trim())).toEqual(['Codex', 'Claude Code', 'Cursor'])
    expect(options.map(option => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(options[2].getAttribute('aria-disabled')).toBe('true')
    options[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(value.value).toBe('claude-code')
    expect(listbox()).toBeNull()
    expect(trigger.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('does not open while disabled', async () => {
    const { wrapper } = mountSelect({ disabled: true })
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.attributes('disabled')).toBeDefined()
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(listbox()).toBeNull()
    wrapper.unmount()
  })
})
