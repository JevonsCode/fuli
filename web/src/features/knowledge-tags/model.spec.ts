import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import {
  governanceRequest, groupByNamespace, historyActionLabel, linkedChange, previewLines, refusalCode,
  type GovernancePreview, type TagEntry, type TagRef,
} from './model'

const ref = (id: string, name = id, namespace: TagRef['namespace'] = 'personal'): TagRef =>
  ({ id, name, namespace, status: 'active' })

function entry(id: string, namespace: TagRef['namespace'] = 'personal', project_id: string | null = null): TagEntry {
  return { ...ref(id, id, namespace), project_id, description: null, aliases: [], provisional_aliases: [],
    proposed_aliases: [], linked_items: 0, parents: [], related: [], merged_into: null, needs_review: false,
    source: { kind: 'human', application: null, reason: 'synthetic' }, version: 1,
    created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' }
}

function preview(overrides: Partial<GovernancePreview>): GovernancePreview {
  return { change: 'merge', tag: ref('a', '户外学习'), other: ref('b', '自然教育'), status_after: 'merged', new_tag_name: null,
    revives: false, links_moved: 3, links_already_on_target: 1, aliases: [], relations_moved: 0, relations_dropped: [],
    undo: null, blocked: null, digest: 'f'.repeat(64), ...overrides }
}

beforeEach(() => setLocale('zh-CN', { persist: false }))

describe('tag governance requests', () => {
  it('sends only what each change needs, and nothing until it is complete', () => {
    const tag = ref('a')
    expect(governanceRequest('merge', tag)).toBeNull()
    expect(governanceRequest('merge', tag, { target: ref('b') })).toEqual({ change: 'merge', tagId: 'a', intoTagId: 'b' })
    expect(governanceRequest('relate', tag, { target: ref('b') })).toBeNull()
    expect(governanceRequest('unrelate', tag, { target: ref('b'), relation: 'related' }))
      .toEqual({ change: 'unrelate', tagId: 'a', targetTagId: 'b', relation: 'related' })
    expect(governanceRequest('undo', tag)).toEqual({ change: 'undo', tagId: 'a' })
    expect(governanceRequest('undo', tag, { operationId: 'op-1' })).toEqual({ change: 'undo', tagId: 'a', operationId: 'op-1' })
    expect(governanceRequest('split', tag, { split: { name: '  ', description: '', aliases: [], links: [] } })).toBeNull()
    expect(governanceRequest('split', tag, { split: { name: ' 野外教学 ', description: ' ', aliases: ['野外课'],
      links: [{ item_kind: 'entity', item_id: 'i1', title: null, attached_at: null, moved_from: null }] } }))
      .toEqual({ change: 'split', tagId: 'a', split: { name: '野外教学', description: null, aliases: ['野外课'],
        links: [{ itemKind: 'entity', itemId: 'i1' }] } })
  })
})

describe('tag vocabulary display', () => {
  it('groups by namespace with the personal vocabulary first and project names', () => {
    const groups = groupByNamespace([entry('x', 'project', 'p1'), entry('y'), entry('z', 'project', 'p1')],
      new Map([['p1', '自然课']]))
    expect(groups.map(group => [group.label, group.tags.map(tag => tag.id)])).toEqual([
      ['项目「自然课」', ['x', 'z']], ['个人词表', ['y']]])
  })

  it('says what a preview will do, without counts it was not given', () => {
    expect(previewLines(preview({}))).toEqual([
      '「户外学习」合并到「自然教育」：之后找「户外学习」会得到「自然教育」。',
      '3 条知识改贴「自然教育」，1 条原本就贴了「自然教育」，不会重复。'])
    const scoped = previewLines(preview({ links_moved: null, links_already_on_target: null, relations_moved: 2,
      relations_dropped: [{ tag: ref('c', '小说'), relation: 'parent', target: ref('b', '自然教育'), reason: 'cycle' }] }))
    expect(scoped).toEqual(['「户外学习」合并到「自然教育」：之后找「户外学习」会得到「自然教育」。',
      '2 条上下位或相关关系转到「自然教育」。', '「小说」与「自然教育」的上位关系会形成循环，不转过去。'])
    expect(previewLines(preview({ change: 'undo', other: null, undo: { operation_id: 'op', action: 'merge',
      created_at: '2026-10-22T00:00:00Z', restores: [ref('a', '户外学习'), ref('b', '自然教育')] } }))).toEqual([
      '撤销这次「合并出去」，恢复：户外学习、自然教育。'])
    expect(previewLines(preview({ change: 'split', other: ref('n', '野外教学'), revives: true, links_moved: 1,
      aliases: ['野外课'] }))).toEqual(['恢复之前合并进「户外学习」的标签「野外教学」。', '1 条知识移到新标签。', '别名移过去：野外课。'])
  })

  it('reads an Agent link, a refusal code and history actions', () => {
    expect(linkedChange({ tag: 't1', change: 'merge', into: 't2' })).toEqual({ tagId: 't1', change: 'merge', intoId: 't2' })
    expect(linkedChange({ tag: 't1', change: 'delete' })).toEqual({ tagId: 't1', change: null, intoId: '' })
    expect(linkedChange({})).toBeNull()
    expect(refusalCode('{"error":"changed","code":"preview_stale"}')).toBe('preview_stale')
    expect(refusalCode('plain text')).toBe('')
    expect(historyActionLabel('merge_in')).toBe('合并进来')
    expect(historyActionLabel('future_action')).toBe('future_action')
  })
})
