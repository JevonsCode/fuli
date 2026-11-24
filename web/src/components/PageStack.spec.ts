import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import PageStack from './PageStack.vue'
import source from './PageStack.vue?raw'

const pages = import.meta.glob<string>('../**/*.vue', { query: '?raw', import: 'default', eager: true })
const styles = (text: string) => [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(([, css]) => css).join('\n')

describe('PageStack', () => {
  it('shows its cards in one column, in source order', () => {
    const wrapper = mount(PageStack, { slots: { default: () => ['a', 'b', 'c'].map(name => h('section', { 'data-card': name })) } })
    expect(wrapper.findAll('[data-card]').map(card => card.attributes('data-card'))).toEqual(['a', 'b', 'c'])
    expect(wrapper.findAll('[data-card]').every(card => card.element.parentElement === wrapper.element)).toBe(true)
    expect(source).toMatch(/\.page-stack \{ display: flex; flex-direction: column;/)
    // Never side by side: no row direction, grid or CSS columns.
    expect(styles(source)).not.toMatch(/flex-direction: row|grid-template-columns|(?<![\w-])(columns|column-count)\s*:/)
  })

  it('is the one way pages stack their cards, and no page deals cards into columns itself', () => {
    const users = Object.entries(pages).filter(([, text]) => /<PageStack\b/.test(text)).map(([file]) => file)
    expect(users.length).toBeGreaterThanOrEqual(5)
    const rebuilt = Object.entries(pages)
      .filter(([file]) => file !== './PageStack.vue')
      .filter(([, text]) => /\bpage-stack\b/.test(text) || /(?<![\w-])(columns|column-count|column-span)\s*:/.test(styles(text)))
      .map(([file]) => file)
    expect(rebuilt).toEqual([])
  })
})
