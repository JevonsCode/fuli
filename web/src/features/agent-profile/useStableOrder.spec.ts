import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useStableOrder } from './useStableOrder'

describe('useStableOrder', () => {
  it('follows fresh data until settled, then keeps the order the reader saw', async () => {
    const fresh = ref(['a', 'b'])
    const settled = ref(false)
    const space = ref('space-a')
    const { order, apply } = useStableOrder(fresh, settled, space)

    fresh.value = ['b', 'a']
    await nextTick()
    expect(order.value).toEqual(['b', 'a'])

    settled.value = true
    await nextTick()
    fresh.value = ['c', 'a', 'b']
    await nextTick()
    expect(order.value).toEqual(['b', 'a', 'c'])

    apply()
    expect(order.value).toEqual(['c', 'a', 'b'])
  })

  it('drops removed rows and starts over for a new scope', async () => {
    const fresh = ref(['a', 'b'])
    const settled = ref(true)
    const space = ref('space-a')
    const { order } = useStableOrder(fresh, settled, space)
    await nextTick()
    fresh.value = ['b']
    await nextTick()
    expect(order.value).toEqual(['b'])

    space.value = 'space-b'
    fresh.value = ['y', 'x']
    await nextTick()
    fresh.value = ['x', 'y']
    await nextTick()
    expect(order.value).toEqual(['y', 'x'])
  })
})
