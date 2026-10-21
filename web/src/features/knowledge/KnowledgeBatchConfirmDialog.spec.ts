import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({ postJson: vi.fn() }))

import KnowledgeBatchConfirmDialog from './KnowledgeBatchConfirmDialog.vue'
import { knowledgeItemFromNode } from './model'

describe('KnowledgeBatchConfirmDialog', () => {
  it('says which selected items a batch confirmation also reviews (dot round 4)', () => {
    const items = [
      knowledgeItemFromNode({ id: 'waiting', name: 'Synthetic waiting', type: 'Fact', epistemic_state_explicit: true,
        waits_for_review: true }),
      knowledgeItemFromNode({ id: 'plain', name: 'Synthetic plain', type: 'Fact', epistemic_state_explicit: true }),
    ]
    const wrapper = mount(KnowledgeBatchConfirmDialog, {
      props: { personalSpaceId: 'space', groups: [{ key: 'source:ep', kind: 'source', value: 'ep', label: 'Synthetic',
        description: 'Synthetic source', items }] },
      global: { plugins: [createPinia()] },
    })
    const rows = wrapper.findAll('.batch-review-item')
    expect(rows).toHaveLength(2)
    expect(rows[0].get('[data-settles-review]').text()).toBe('这也会把「依据已变，待复核」标记为已复核。')
    expect(rows[1].find('[data-settles-review]').exists()).toBe(false)
    wrapper.unmount()
  })
})
