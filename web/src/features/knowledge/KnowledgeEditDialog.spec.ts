import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const patchJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  patchJson,
  postJson,
}))

import KnowledgeEditDialog from './KnowledgeEditDialog.vue'
import { knowledgeItemFromNode } from './model'

describe('KnowledgeEditDialog', () => {
  it('isolates a late scope write from a new record and preserves exact POST semantics', async () => {
    let resolve!: (value: unknown) => void
    postJson.mockReturnValue(new Promise(r => { resolve = r }))
    const item = knowledgeItemFromNode({ id: 'scope-race', name: 'Synthetic scope', type: 'Preference', profile_aspect: 'taste', preference_scope: 'global' })
    const wrapper = mount(KnowledgeEditDialog, { props: { item, personalSpaceId: 'scope-a', personalProjectId: null, projects: [] }, global: { plugins: [createPinia()] } })
    const reason = wrapper.findAll('label').find(label => label.text().includes('调整原因'))
      ?? wrapper.findAll('label').at(-1)
    await reason!.get('textarea').setValue('Synthetic scope reason')
    await wrapper.findAll('form')[1]!.trigger('submit')
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/entity/scope-race/preference-scope', { personalSpaceId: 'scope-a', scope: 'global', projectId: null, reason: 'Synthetic scope reason' })
    await wrapper.setProps({ item: { ...item, id: 'other-record' }, personalSpaceId: 'scope-b' })
    resolve({}); await flushPromises()
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('dialog').attributes('aria-busy')).toBeUndefined()
    wrapper.unmount()
  })
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
      .findAllComponents({ name: 'OptionCombobox' })
      .find((component) => component.props('label') === '选择当前有效的内容')
    expect(replacementSelect).toBeDefined()
    const replacementOption = (replacementSelect!.props('options') as Array<{ value: string, label: string }>)
      .find((option) => option.label.includes('当前交付口径'))
    replacementSelect!.vm.$emit('update:modelValue', replacementOption!.value)

    const reasonLabel = wrapper
      .findAll('label')
      .find((label) => label.text().includes('纠正原因'))
    await reasonLabel!.get('textarea').setValue('当前口径已经完成审核。')
    await wrapper.get('.knowledge-editor-actions button:not([type="submit"])').trigger('click')
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
      .findAllComponents({ name: 'OptionSelect' })
      .find((component) => component.props('label') === '当前分类')
    const unknownKnown = (quadrant!.props('options') as Array<{ value: string, label: string }>)
      .find((option) => option.label.includes('未知的已知'))
    quadrant!.vm.$emit('update:modelValue', unknownKnown!.value)
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
