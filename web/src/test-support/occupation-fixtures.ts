import type { OccupationEntry } from '@/features/occupations/occupation-catalog'

/** A synthetic space catalog: one active built-in row per [key, Chinese name]. */
export function syntheticOccupations(rows: readonly (readonly [string, string])[]): OccupationEntry[] {
  return rows.map(([key, name]) => ({
    key, name_zh: name, name_en: key, description_zh: `${name}的职责说明`, description_en: `${key} duties`,
    builtin: true, status: 'active', revision: 0, agent_count: 0,
    created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z',
  }))
}

export const SYNTHETIC_OCCUPATIONS = syntheticOccupations([
  ['lead', '负责人'], ['product', '产品'], ['engineering', '工程'], ['design', '设计'], ['testing', '测试'],
  ['research', '研究'], ['data', '数据'], ['writing', '写作'], ['management', '管理'], ['hr', 'Agent 资源'],
])
