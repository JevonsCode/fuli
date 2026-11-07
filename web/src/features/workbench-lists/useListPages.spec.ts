import { flushPromises } from '@vue/test-utils'
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useListPages, type ListPage, type ListSource } from './useListPages'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('useListPages', () => {
  it('reads the first page, appends the next and stops at the last', async () => {
    const read = vi.fn(async (cursor: string | null): Promise<ListPage<number>> => (cursor
      ? { items: [3, 4], nextCursor: null }
      : { items: [1, 2], nextCursor: 'two', total: 4 }))
    const pages = effectScope().run(() => useListPages(ref<ListSource<number>>({ key: 'a', read })))!
    await flushPromises()
    expect(pages.items.value).toEqual([1, 2])
    expect(pages.total.value).toBe(4)
    await pages.more()
    expect(pages.items.value).toEqual([1, 2, 3, 4])
    await pages.more()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the rows shown while a new query reads, and drops an answer for the old one', async () => {
    const slow = deferred<ListPage<string>>()
    const source = ref<ListSource<string>>({ key: 'a', read: async () => ({ items: ['old'], nextCursor: 'more' }) })
    const pages = effectScope().run(() => useListPages(source))!
    await flushPromises()
    source.value = { key: 'b', read: () => slow.promise }
    await flushPromises()
    expect(pages.loading.value).toBe(true)
    expect(pages.items.value).toEqual(['old'])
    source.value = { key: 'c', read: async () => ({ items: ['new'], nextCursor: null }) }
    await flushPromises()
    slow.resolve({ items: ['stale'], nextCursor: null })
    await flushPromises()
    expect(pages.items.value).toEqual(['new'])
    expect(pages.loading.value).toBe(false)
  })

  it('says a read failed and reads again on request', async () => {
    let fail = true
    const pages = effectScope().run(() => useListPages(ref<ListSource<number>>({ key: 'a', read: async () => {
      if (fail) throw new Error('offline')
      return { items: [1], nextCursor: null }
    } })))!
    await flushPromises()
    expect(pages.error.value).toBeInstanceOf(Error)
    fail = false
    await pages.reload()
    expect(pages.error.value).toBeNull()
    expect(pages.items.value).toEqual([1])
  })
})
