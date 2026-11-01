import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { fuliWordmarkUrl, LOADING_ARCS } from './brand'

describe('the FULI brand source', () => {
  it('gives the wordmark for the interface language', () => {
    expect(fuliWordmarkUrl('zh-CN')).toMatch(/fuli-wordmark-zh/)
    expect(fuliWordmarkUrl('en-US')).toMatch(/fuli-wordmark-en/)
  })

  it('is where the loading mark gets its arcs', () => {
    const arcs = mount(GrowthLoading, { props: { label: '正在读取' } }).findAll('.growth-loading__arc')
    expect(arcs.map(arc => arc.attributes('d'))).toEqual([...LOADING_ARCS])
  })
})
