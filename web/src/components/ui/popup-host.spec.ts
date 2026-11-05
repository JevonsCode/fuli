import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { UiDialog } from '@/ui'
import { usePopupTarget } from './popup-host'

const Probe = defineComponent({
  setup() {
    const target = usePopupTarget()
    return () => h('span', { 'data-target': target.value instanceof HTMLElement ? target.value.tagName : target.value })
  },
})

describe('usePopupTarget', () => {
  it('stays on the body outside a dialog', () => {
    expect(mount(Probe).get('[data-target]').attributes('data-target')).toBe('body')
  })

  it('is the dialog inside one, so a popup is not left behind the top layer', async () => {
    const wrapper = mount(UiDialog, { props: { open: true, title: 'Synthetic' }, slots: { default: () => h(Probe) }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.get('[data-target]').attributes('data-target')).toBe('DIALOG')
    wrapper.unmount()
  })
})
