import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import KnowledgePeek from './KnowledgePeek.vue'
import { knowledgeItemFromEdge, knowledgeItemFromNode } from './model'

const peek = () => new DOMWrapper(document.body).find('[data-knowledge-peek]')
const node = {
  id: 'synthetic-node', name: 'Synthetic title', type: 'Decision', summary: 'Synthetic body',
  epistemic_state_explicit: true, confirmation_status: 'pending',
}

// A project item reads the console store for its record; plain items never do.
beforeEach(() => setActivePinia(createPinia()))

describe('KnowledgePeek', () => {
  it('names the item once in its header and hands actions to the page', async () => {
    const item = knowledgeItemFromNode(node)
    const onConfirm = vi.fn()
    const wrapper = mount(KnowledgePeek, { props: { item, graph: { nodes: [node], edges: [] }, editable: true, mode: 'directory', onConfirm } })
    await flushPromises()
    expect(peek().attributes('role')).toBe('dialog')
    expect(peek().get('h2').text()).toBe('Synthetic title')
    expect(peek().text()).toContain('Synthetic body')
    // The inspector no longer repeats the title under the header.
    expect(peek().findAll('h3')).toHaveLength(0)
    await peek().get('.inspector-confirm-action').trigger('click')
    expect(onConfirm).toHaveBeenCalledWith(item)
    wrapper.unmount()
  })

  it('names a relationship by its type', async () => {
    const edge = { id: 'edge', source: 'a', target: 'b', type: 'DEPENDS_ON', fact: 'Synthetic fact' }
    const wrapper = mount(KnowledgePeek, { props: { item: knowledgeItemFromEdge(edge, new Map()), graph: { nodes: [], edges: [edge] } } })
    await flushPromises()
    expect(peek().get('h2').text()).toBe('DEPENDS_ON')
    expect(peek().text()).toContain('Synthetic fact')
    wrapper.unmount()
  })

  it('steps aside while a form it opened is up and comes back on the same item', async () => {
    const item = knowledgeItemFromNode(node)
    const wrapper = mount(KnowledgePeek, { props: { item, graph: { nodes: [node], edges: [] }, editable: true } })
    await flushPromises()
    await wrapper.setProps({ suspended: true })
    await flushPromises()
    expect(peek().exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.setProps({ suspended: false })
    await flushPromises()
    expect(peek().get('h2').text()).toBe('Synthetic title')
    wrapper.unmount()
  })

  it('asks the page to close on Escape', async () => {
    const wrapper = mount(KnowledgePeek, { props: { item: knowledgeItemFromNode(node), graph: { nodes: [node], edges: [] } } })
    await flushPromises()
    await peek().trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
