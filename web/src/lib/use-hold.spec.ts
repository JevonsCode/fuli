import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useHold } from './use-hold'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const press = (wrapper: { element: Element }, button: number) => { wrapper.element.dispatchEvent(new MouseEvent('pointerdown', { button })) }

function mountButton() {
  const onHeld = vi.fn()
  const onClick = vi.fn()
  const wrapper = mount(defineComponent({
    setup() {
      const { shaking, handlers } = useHold(onHeld)
      return () => h('a', { ...handlers, onClick, class: { shaking: shaking.value } })
    },
  }))
  return { wrapper, onHeld, onClick }
}

it('shakes from the second second and acts at the third, swallowing the release click', async () => {
  const { wrapper, onHeld, onClick } = mountButton()
  press(wrapper, 0)
  await vi.advanceTimersByTimeAsync(1999)
  expect(wrapper.get('a').classes()).not.toContain('shaking')
  await vi.advanceTimersByTimeAsync(1)
  expect(wrapper.get('a').classes()).toContain('shaking')
  await vi.advanceTimersByTimeAsync(1000)
  expect(onHeld).toHaveBeenCalledTimes(1)
  expect(wrapper.get('a').classes()).not.toContain('shaking')
  await wrapper.get('a').trigger('pointerup')
  await wrapper.get('a').trigger('click')
  expect(onClick).not.toHaveBeenCalled()
})

it('letting go early changes nothing: no action, and the click goes through', async () => {
  const { wrapper, onHeld, onClick } = mountButton()
  press(wrapper, 0)
  await vi.advanceTimersByTimeAsync(2500)
  await wrapper.get('a').trigger('pointerup')
  await vi.advanceTimersByTimeAsync(2000)
  expect(onHeld).not.toHaveBeenCalled()
  expect(wrapper.get('a').classes()).not.toContain('shaking')
  await wrapper.get('a').trigger('click')
  expect(onClick).toHaveBeenCalledTimes(1)
})

it('ignores a right button and a pointer that left', async () => {
  const { wrapper, onHeld } = mountButton()
  press(wrapper, 2)
  await vi.advanceTimersByTimeAsync(3000)
  press(wrapper, 0)
  await wrapper.get('a').trigger('pointerleave')
  await vi.advanceTimersByTimeAsync(3000)
  expect(onHeld).not.toHaveBeenCalled()
})
