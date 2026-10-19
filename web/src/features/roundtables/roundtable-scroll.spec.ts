import { afterEach, describe, expect, it } from 'vitest'

import { rememberPlace, restorePlace } from './roundtable-scroll'

// A scrolling list of 100px cards whose positions follow scrollTop, like a browser.
function list(keys: string[]) {
  const box = document.createElement('div')
  box.style.overflowY = 'auto'
  let top = 0
  Object.defineProperty(box, 'scrollTop', { get: () => top, set: (value: number) => { top = value } })
  Object.defineProperty(box, 'clientHeight', { value: 500 })
  Object.defineProperty(box, 'scrollHeight', { get: () => box.children.length * 100 })
  box.getBoundingClientRect = () => ({ top: 80, bottom: 580 } as DOMRect)
  for (const key of keys) box.append(card(box, key))
  document.body.append(box)
  return box
}
function card(box: HTMLElement, key: string) {
  const item = document.createElement('a')
  item.dataset.roundtableKey = key
  item.tabIndex = -1
  item.getBoundingClientRect = () => {
    const top = 80 + [...box.children].indexOf(item) * 100 - box.scrollTop
    return { top, bottom: top + 100 } as DOMRect
  }
  return item
}
const keys = (count: number, prefix = 'thread') => Array.from({ length: count }, (_, i) => `${prefix}:${i}`)

describe('list place', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('returns the first visible card to the same offset', async () => {
    const box = list(keys(50))
    box.scrollTop = 1017
    const place = rememberPlace(box, 'thread:11')
    expect(place).toEqual({ key: 'thread:11', anchor: 'thread:10', offset: -17 })
    box.scrollTop = 0
    await restorePlace(box, place, () => null)
    expect(box.scrollTop).toBe(1017)
    expect(document.activeElement?.getAttribute('data-roundtable-key')).toBe('thread:11')
  })

  it('keeps the card in place when new cards arrive above it', async () => {
    const box = list(keys(50))
    box.scrollTop = 1017
    const place = rememberPlace(box, 'thread:11')
    box.prepend(...keys(2, 'chat').map(key => card(box, key)))
    box.scrollTop = 0
    await restorePlace(box, place, () => null)
    expect(box.scrollTop).toBe(1217)
  })
})
