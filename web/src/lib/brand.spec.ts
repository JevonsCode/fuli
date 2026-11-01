import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { FULI_MARK, fuliWordmarkUrl, markCut } from './brand'

describe('the FULI brand source', () => {
  it('gives the wordmark for the interface language', () => {
    expect(fuliWordmarkUrl('zh-CN')).toMatch(/fuli-wordmark-zh/)
    expect(fuliWordmarkUrl('en-US')).toMatch(/fuli-wordmark-en/)
  })

  it('switches to the micro cut below 28 px', () => {
    expect([16, 24, 27].map(markCut)).toEqual(['micro', 'micro', 'micro'])
    expect([28, 38, 48].map(markCut)).toEqual(['master', 'master', 'master'])
  })

  it('gives the mark its own ink and white', () => {
    expect([FULI_MARK.ink, FULI_MARK.white]).toEqual(['#18181B', '#FFFFFF'])
  })

  it('is where the loading mark gets its layers', () => {
    const wrapper = mount(GrowthLoading, { props: { label: '正在读取' } })
    const layers = wrapper.findAll('.fuli-mark-group path').map(path => path.attributes('d'))
    const { orbitGold, orbitUpper, wave, bars } = FULI_MARK.master
    expect(layers).toEqual([orbitGold, orbitUpper, wave, ...bars])
  })
})
