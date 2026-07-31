import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import {
  localizeRelationTokens,
  relationVisual,
  uniqueRelationVisuals,
} from './relation-visuals'

describe('relation visuals', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('translates graph enums into compact Chinese labels and icons', () => {
    expect(relationVisual('PART_OF')).toMatchObject({
      label: '属于',
      description: '子项目属于上级项目',
    })
    expect(relationVisual('HAS_SOURCE')).toMatchObject({
      label: '来源',
      description: '项目登记的资料来源',
    })
    expect(relationVisual('HAS_SOURCE').iconPath).not.toBe('')
  })

  it('uses a neutral Chinese fallback and deduplicates legend entries', () => {
    expect(relationVisual('CUSTOM_RELATION')).toMatchObject({
      label: '关联',
      description: '两个节点之间的关联关系',
    })
    expect(uniqueRelationVisuals(['HAS_SOURCE', 'has_source', 'PART_OF']))
      .toHaveLength(2)
  })

  it('localizes known enum tokens in canvas copy without changing the source value', () => {
    const source = '子项目通过 PART_OF 关系归属父项目'

    expect(localizeRelationTokens(source)).toBe('子项目通过 “属于” 关系归属父项目')
    expect(source).toContain('PART_OF')
  })

  it('switches relationship labels while preserving the technical enum', () => {
    setLocale('en-US', { persist: false })

    expect(relationVisual('PART_OF')).toMatchObject({
      type: 'PART_OF',
      label: 'Belongs to',
      description: 'A child project belongs to a parent project',
    })
    expect(localizeRelationTokens('PART_OF')).toBe('“Belongs to”')
  })
})
