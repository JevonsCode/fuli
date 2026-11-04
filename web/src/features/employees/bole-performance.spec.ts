import { describe, expect, it } from 'vitest'
import { dimensionRows, performanceSummary, scoreCardShape, toolFlagLines, type ScoreCard } from './bole-performance'

const insufficient = { status: 'insufficient_data', sample: 1, label: '数据不足' } as const
const card = {
  minimumSample: 3,
  dimensions: {
    completion: { status: 'scored', sample: 8, passed: 4, rate: 0.5, tier: { label: 'B', evidenceCount: 8 } },
    firstPass: insufficient, userFeedback: insufficient, review: insufficient,
  },
  toolFlags: [{ dimension: 'completion', executorId: 'executor-b', rate: 0, comparedExecutorId: 'executor-a', comparedRate: 1 }],
  disputedReviewCount: 0, staleReviewCount: 0, asOf: '2026-10-20T08:00:00.000Z',
} satisfies ScoreCard

describe('Bole performance', () => {
  it('keeps the dimensions separate and gives too little data no rate or tier', () => {
    const rows = dimensionRows(card)
    expect(rows.map(row => row.key)).toEqual(['completion', 'firstPass', 'userFeedback', 'review'])
    expect(rows[0]).toMatchObject({ label: '完成', scored: true, tier: 'B', rate: '50%', passed: 4, sample: 8 })
    expect(rows[1]).toEqual({ key: 'firstPass', label: '一次通过', scored: false, sample: 1 })
  })

  it('sums up only what was scored and counts the rest as too little data', () => {
    const summary = performanceSummary(card)
    expect(summary.scored.map(row => row.key)).toEqual(['completion'])
    expect(summary.insufficient).toBe(3)
  })

  it('names both executors of a tool flag', () => {
    expect(toolFlagLines(card)).toEqual(['完成：executor-b 0%，executor-a 100%。换模型或客户端试试，不必换人。'])
  })

  it('refuses a scored dimension without a tier instead of showing it', () => {
    const broken = { ...card, dimensions: { ...card.dimensions, completion: { status: 'scored', sample: 8 } } }
    expect(scoreCardShape.schema.safeParse(card).success).toBe(true)
    expect(scoreCardShape.schema.safeParse(broken).success).toBe(false)
  })
})
