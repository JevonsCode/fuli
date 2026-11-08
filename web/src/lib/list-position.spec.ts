import { describe, expect, it } from 'vitest'

import { listPositionText } from './list-position'

describe('listPositionText', () => {
  it('writes plain numbers, never zero-padded', () => {
    expect(listPositionText(1, 39, 'zh-CN')).toEqual({ current: '1', total: '39', widest: '39' })
  })

  it('groups thousands per locale and reserves the total written in full', () => {
    expect(listPositionText(1284, 25_000, 'en-US')).toEqual({ current: '1,284', total: '25,000', widest: '25,000' })
    expect(listPositionText(7, 1284, 'de-DE')).toEqual({ current: '7', total: '1.284', widest: '1.284' })
  })

  it('compacts only the total once it is very large, keeping the full width reserved', () => {
    expect(listPositionText(88_001, 123_456, 'en-US')).toEqual({ current: '88,001', total: '123.5K', widest: '123,456' })
    expect(listPositionText(88_001, 123_456, 'zh-CN')).toMatchObject({ total: '12.3万', widest: '123,456' })
  })
})
