import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'

import { setLocale } from '@/i18n'
import TodayEmpty from './TodayEmpty.vue'

const passThrough = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
const panel = defineComponent({ props: { ask: { type: String, required: true } }, setup: props => () => h('i', { 'data-ask': props.ask }) })
const opener = () => mount(TodayEmpty, {
  global: { stubs: { Popover: passThrough, PopoverTrigger: passThrough, PopoverContent: passThrough, NewSessionPanel: panel } },
}).get('[data-ask]').attributes('data-ask')

describe('TodayEmpty', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => setLocale('zh-CN', { persist: false }))

  it('hands the client a request to remember a habit that names no assistant', () => {
    setLocale('zh-CN', { persist: false })
    expect(opener()).toBe('记住我的一个习惯：')
    setLocale('en-US', { persist: false })
    expect(opener()).toBe('Remember one of my habits: ')
  })
})
