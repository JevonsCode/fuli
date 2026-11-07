import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { reloadPage, usePageRefresh } from './page-refresh'

const page = (reload: () => unknown) => defineComponent({ setup() { usePageRefresh(reload); return () => h('div') } })

describe('page refresh', () => {
  it('runs the mounted page\'s reads and forgets them when the page leaves', async () => {
    const reload = vi.fn()
    const wrapper = mount(page(reload))
    await reloadPage()
    expect(reload).toHaveBeenCalledOnce()
    wrapper.unmount()
    await reloadPage()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('settles after every read, a failed one included', async () => {
    let finish: () => void = () => {}
    const slow = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const failing = vi.fn(() => { throw new Error('offline') })
    const first = mount(page(slow))
    const second = mount(page(failing))
    let settled = false
    const pending = reloadPage().then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    expect(failing).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    finish()
    await pending
    expect(settled).toBe(true)
    first.unmount(); second.unmount()
  })
})
