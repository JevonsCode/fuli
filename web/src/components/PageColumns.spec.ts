import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import PageColumns from './PageColumns.vue'
import source from './PageColumns.vue?raw'

const Card = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props) {
    const open = ref(false)
    return () => h('section', { 'data-card': props.name, 'data-open': open.value, onClick: () => { open.value = !open.value } },
      open.value ? [props.name, h('p', 'details')] : props.name)
  },
})

const names = (element: Element) => [...element.querySelectorAll('[data-card]')].map(card => card.getAttribute('data-card'))

function stacks(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.page-columns-row').map(row => ({
    left: names(row.get('[data-column="left"]').element),
    right: names(row.get('[data-column="right"]').element),
  }))
}

const pages = import.meta.glob<string>('../**/*.vue', { query: '?raw', import: 'default', eager: true })

describe('PageColumns', () => {
  it('deals cards left, right, left… through fragments and skipped v-if branches', () => {
    const wrapper = mount(PageColumns, {
      slots: {
        default: () => [
          h(Card, { name: 'a' }),
          null,
          [h(Card, { name: 'b' }), h(Card, { name: 'c' })],
          h(Card, { name: 'd' }),
          h(Card, { name: 'e' }),
        ],
      },
    })
    expect(stacks(wrapper)).toEqual([{ left: ['a', 'c', 'e'], right: ['b', 'd'] }])
  })

  it('lets a data-span="wide" card close the pair and span both columns', () => {
    const wrapper = mount(PageColumns, {
      slots: {
        default: () => [
          h(Card, { name: 'a' }),
          h(Card, { name: 'wide', 'data-span': 'wide' }),
          h(Card, { name: 'b' }),
          h(Card, { name: 'c' }),
          h(Card, { name: 'd' }),
        ],
      },
    })
    expect(stacks(wrapper)).toEqual([{ left: ['a'], right: [] }, { left: ['b', 'd'], right: ['c'] }])
    const wide = wrapper.get('[data-card="wide"]')
    expect(wide.element.parentElement?.parentElement).toBe(wrapper.element)
    expect(wide.element.closest('.page-columns-row')).toBeNull()
  })

  it('keeps a card in its column and its state when a card grows', async () => {
    const wrapper = mount(PageColumns, { slots: { default: () => ['a', 'b', 'c', 'd'].map(name => h(Card, { name })) } })
    const before = stacks(wrapper)
    const c = wrapper.get('[data-card="c"]').element
    await wrapper.get('[data-card="a"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-card="a"]').attributes('data-open')).toBe('true')
    expect(stacks(wrapper)).toEqual(before)
    expect(wrapper.get('[data-card="c"]').element).toBe(c)
  })

  it('shows one column in source order below two card widths, without re-mounting the cards', () => {
    const wrapper = mount(PageColumns, { slots: { default: () => ['a', 'b', 'c', 'd'].map(name => h(Card, { name })) } })
    const order = wrapper.findAll('.page-columns-cell').map(cell => [
      cell.get('[data-card]').attributes('data-card'), (cell.element as HTMLElement).style.getPropertyValue('--page-columns-order')])
    expect(Object.fromEntries(order)).toEqual({ a: '0', b: '1', c: '2', d: '3' })
    // Narrow: rows and stacks are display: contents, so cards are the row's flex items in that order.
    expect(source).toMatch(/\.page-columns \{ container-type: inline-size;/)
    expect(source).toMatch(/\.page-columns-stack, \.page-columns-cell \{ display: contents; \}/)
    expect(source).toMatch(/\.page-columns-row \.page-columns-cell > \* \{ order: var\(--page-columns-order\); \}/)
    const wide = source.slice(source.indexOf('@container (min-width: 1056px)'))
    expect(wide).toMatch(/\.page-columns-row \{ flex-direction: row;/)
    expect(wide).toMatch(/\.page-columns-stack \{ display: flex; flex: 1 1 0; flex-direction: column; gap: var\(--space-4\);/)
    expect(source).not.toMatch(/(?<![\w-])(columns|column-count|column-span)\s*:|@media/)
  })

  it('is the only place that builds page columns', () => {
    const users = Object.entries(pages).filter(([, text]) => /<PageColumns\b/.test(text)).map(([file]) => file)
    expect(users.length).toBeGreaterThanOrEqual(5)
    const styles = (text: string) => [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(([, css]) => css).join('\n')
    const rebuilt = Object.entries(pages)
      .filter(([file]) => file !== './PageColumns.vue')
      .filter(([, text]) => /\bpage-columns\b/.test(text) || /(?<![\w-])(columns|column-count|column-span)\s*:/.test(styles(text)))
      .map(([file]) => file)
    expect(rebuilt).toEqual([])
  })
})
