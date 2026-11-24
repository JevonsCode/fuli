import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import UiDialog from './UiDialog.vue'

// Where a dialog's first focus goes, and that Tab still reaches every control in it.
const dialogWith = (content: () => ReturnType<typeof h>[]) => defineComponent({
  props: { open: Boolean },
  setup: props => () => h(UiDialog, { open: props.open, title: 'Synthetic dialog' }, { default: content, footer: () => [h('button', { type: 'button' }, 'Done')] }),
})
const active = () => document.activeElement as HTMLElement
const tab = (shift = false) => active().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }))

afterEach(() => { document.body.innerHTML = '' })

async function opened(content: () => ReturnType<typeof h>[]) {
  const wrapper = mount(dialogWith(content), { props: { open: false }, attachTo: document.body })
  await wrapper.setProps({ open: true })
  await flushPromises()
  return wrapper
}

describe('UiDialog first focus', () => {
  it('goes to the content, not to a button the content starts with', async () => {
    const wrapper = await opened(() => [h('button', { type: 'button' }, 'Last week'), h('button', { type: 'button' }, 'This week')])
    const body = wrapper.get('.ui-dialog__body').element as HTMLElement
    expect(active()).toBe(body)
    expect(body.tabIndex).toBe(-1)
    // The content is not a Tab stop itself: the trap wraps between the dialog's own controls.
    wrapper.findAll('button').at(-1)!.element.focus()
    expect(tab().valueOf()).toBe(false)
    expect(active().getAttribute('aria-label')).toBeTruthy()
    expect(tab(true).valueOf()).toBe(false)
    expect(active().textContent).toBe('Done')
    wrapper.unmount()
  })

  it('goes to a field the content starts with, and to the marked control when one is marked', async () => {
    const field = await opened(() => [h('input', { name: 'synthetic' }), h('button', { type: 'button' }, 'Other')])
    expect(active().tagName).toBe('INPUT')
    field.unmount()
    const choice = await opened(() => [h('input', { type: 'checkbox' }), h('input', { name: 'synthetic' })])
    expect(active()).toBe(choice.get('.ui-dialog__body').element)
    choice.unmount()
    const marked = await opened(() => [h('button', { type: 'button' }, 'First'), h('button', { type: 'button', autofocus: true }, 'Marked')])
    expect(active().textContent).toBe('Marked')
    marked.unmount()
  })
})
