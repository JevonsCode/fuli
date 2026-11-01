<script lang="ts">
import { Comment, Fragment, Text, defineComponent, h, type VNode, type VNodeArrayChildren } from 'vue'

function cards(children: VNodeArrayChildren): VNode[] {
  return children.flatMap((child): VNode[] => {
    if (Array.isArray(child)) return cards(child)
    if (!child || typeof child !== 'object') return []
    if (child.type === Fragment) return cards(child.children as VNodeArrayChildren)
    if (child.type === Comment || (child.type === Text && !String(child.children).trim())) return []
    return [child]
  })
}

const isWide = (card: VNode) => card.props?.['data-span'] === 'wide'

// Cards between two wide cards; each goes to a column by its place among them.
function segments(list: VNode[]): Array<VNode | VNode[]> {
  const result: Array<VNode | VNode[]> = []
  for (const card of list) {
    const last = result.at(-1)
    if (isWide(card)) result.push(card)
    else if (Array.isArray(last)) last.push(card)
    else result.push([card])
  }
  return result
}

/**
 * Cards side by side on a page that keeps the workbench's width. Children
 * alternate between two column stacks (left, right, left…), so a card that
 * grows only pushes down the cards below it in its own column; nothing moves
 * to the other column. A child with data-span="wide" closes the pair and spans
 * both. Below two card widths a container query shows one column in source
 * order. Each card sits in a display: contents cell, so it keeps its state
 * across widths and a card that renders nothing leaves no gap.
 */
export default defineComponent({
  name: 'PageColumns',
  setup(_, { slots }) {
    const cell = (card: VNode, index: number) =>
      h('div', { key: card.key ?? index, class: 'page-columns-cell', style: { '--page-columns-order': index } }, [card])
    return () => h('div', { class: 'page-columns' }, segments(cards(slots.default?.() ?? [])).map((segment, index) => {
      if (!Array.isArray(segment)) return h('div', { key: `wide-${String(segment.key ?? index)}`, class: 'page-columns-cell' }, [segment])
      const stack = (side: number) =>
        h('div', { class: 'page-columns-stack', 'data-column': side ? 'right' : 'left' },
          segment.flatMap((card, place) => place % 2 === side ? [cell(card, place)] : []))
      return h('div', { key: `row-${index}`, class: 'page-columns-row' }, [stack(0), stack(1)])
    }))
  },
})
</script>

<style>
/*
 * Not scoped: the rules reach the cells and stacks this component renders and
 * the cards inside them. Narrow (one column): rows and stacks are display:
 * contents, so every card is a flex item of its row, ordered by its source
 * place. 1056px is two 520px cards and the gap.
 */
.page-columns { container-type: inline-size; display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.page-columns-row { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.page-columns-stack, .page-columns-cell { display: contents; }
.page-columns-row .page-columns-cell > * { order: var(--page-columns-order); }

@container (min-width: 1056px) {
  .page-columns-row { flex-direction: row; align-items: flex-start; }
  .page-columns-stack { display: flex; flex: 1 1 0; flex-direction: column; gap: var(--space-4); min-width: 0; }
}
</style>
