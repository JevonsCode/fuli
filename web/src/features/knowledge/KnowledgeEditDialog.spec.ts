import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const patchJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  patchJson,
  postJson,
}))

import SearchableSelect from '@/components/SearchableSelect.vue'
import KnowledgeEditDialog from './KnowledgeEditDialog.vue'
import { knowledgeItemFromNode } from './model'

describe('KnowledgeEditDialog', () => {
  beforeEach(() => {
    patchJson.mockReset()
    patchJson.mockResolvedValue({})
    postJson.mockReset()
  })

  it('stores an explicitly selected replacement when invalidating knowledge', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const oldItem = knowledgeItemFromNode({
      id: 'requirement-old',
      name: '旧交付口径',
      type: 'Requirement',
      summary: '需要由当前口径取代。',
    })
    const currentItem = knowledgeItemFromNode({
      id: 'requirement-current',
      name: '当前交付口径',
      type: 'Requirement',
      summary: '经过审核的当前内容。',
    })
    const wrapper = mount(KnowledgeEditDialog, {
      props: {
        item: oldItem,
        personalSpaceId: 'space-1',
        personalProjectId: 'project-1',
        projects: [],
        replacementItems: [oldItem, currentItem],
      },
      global: { plugins: [pinia] },
    })

    const replacementSelect = wrapper
      .findAllComponents(SearchableSelect)
      .find((component) => component.props('label') === '替代内容')
    expect(replacementSelect).toBeDefined()
    await replacementSelect!.get('[role="combobox"]').trigger('click')
    const replacementOption = replacementSelect!
      .findAll('.searchable-select-option')
      .find((option) => option.text().includes('当前交付口径'))
    await replacementOption!.trigger('click')

    const reasonLabel = wrapper
      .findAll('label')
      .find((label) => label.text().includes('纠正原因'))
    await reasonLabel!.get('textarea').setValue('当前口径已经完成审核。')
    await wrapper.get('.knowledge-editor-actions button.secondary-action').trigger('click')
    await flushPromises()

    expect(patchJson).toHaveBeenCalledWith(
      '/api/knowledge/entity/requirement-old',
      {
        personalSpaceId: 'space-1',
        personalProjectId: 'project-1',
        action: 'invalidate',
        reason: '当前口径已经完成审核。',
        replacementItemId: 'requirement-current',
        replacementItemKind: 'entity',
      },
    )
  })
})
