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

  it('establishes a legacy discovery quadrant once instead of rewriting current classification', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const item = knowledgeItemFromNode({
      id: 'legacy-rule',
      name: '旧规则',
      type: 'Requirement',
      summary: '缺少显式发现来源。',
      confirmation_status: 'pending',
      confirmation_state_explicit: true,
      confirmation_basis: {
        existence_reason: '由旧版本导入。',
        quadrant_reason: '需要人工补录发现来源。',
        proposed_by: { kind: 'import', label: '旧版本' },
      },
    })
    const wrapper = mount(KnowledgeEditDialog, {
      props: {
        item,
        personalSpaceId: 'space-1',
        personalProjectId: null,
        projects: [],
        replacementItems: [item],
      },
      global: { plugins: [pinia] },
    })

    const quadrant = wrapper
      .findAllComponents(SearchableSelect)
      .find((component) => component.props('label') === '当前分类')
    await quadrant!.get('[role="combobox"]').trigger('click')
    await quadrant!
      .findAll('.searchable-select-option')
      .find((option) => option.text().includes('未知的已知'))!
      .trigger('click')
    const reason = wrapper
      .findAll('label')
      .find((label) => label.text().includes('纠正原因'))
    await reason!.get('textarea').setValue('补录旧知识的发现来源。')
    await wrapper.findAll('form')[0].trigger('submit')
    await flushPromises()

    const body = patchJson.mock.calls[0][1]
    expect(body.originQuadrant).toBe('unknown_known')
    expect(body.currentQuadrant).toBeUndefined()
  })
})
