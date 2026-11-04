import { z } from 'zod'
import { shapeOf } from '@/api/response-shape'
import { currentLocale, t } from '@/i18n'

// Bole's score card as the console API answers it: separate dimensions, each
// with its sample and no total. Below the minimum sample a dimension has no
// rate or tier, so it can only ever read as 数据不足, never as poor work.
const scoredDimension = z.looseObject({
  status: z.literal('scored'),
  sample: z.number(),
  passed: z.number(),
  rate: z.number(),
  tier: z.looseObject({ label: z.string(), evidenceCount: z.number() }),
})
const insufficientDimension = z.looseObject({ status: z.literal('insufficient_data'), sample: z.number() })
const dimension = z.discriminatedUnion('status', [scoredDimension, insufficientDimension])
const DIMENSIONS = ['completion', 'firstPass', 'userFeedback', 'review'] as const
type DimensionKey = (typeof DIMENSIONS)[number]

const scoreCardSchema = z.looseObject({
  minimumSample: z.number(),
  dimensions: z.looseObject({ completion: dimension, firstPass: dimension, userFeedback: dimension, review: dimension }),
  toolFlags: z.array(z.looseObject({
    dimension: z.enum(DIMENSIONS),
    executorId: z.string(),
    rate: z.number(),
    comparedExecutorId: z.string(),
    comparedRate: z.number(),
  })),
  disputedReviewCount: z.number(),
  staleReviewCount: z.number(),
  asOf: z.string(),
})
export const scoreCardShape = shapeOf(scoreCardSchema)
export type ScoreCard = z.infer<typeof scoreCardSchema>

const dimensionLabel = (key: DimensionKey) => t(`employees.bole.performance.dimensions.${key}`)
const percent = (rate: number) => new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(rate)

/** The card's four dimensions in reading order, each with its label. */
export function dimensionRows(card: ScoreCard) {
  return DIMENSIONS.map((key) => {
    const value = card.dimensions[key]
    return value.status === 'scored'
      ? { key, label: dimensionLabel(key), scored: true as const, tier: value.tier.label, rate: percent(value.rate), passed: value.passed, sample: value.sample }
      : { key, label: dimensionLabel(key), scored: false as const, sample: value.sample }
  })
}

/** What a person's card shows: each scored dimension, and how many have too little data. */
export function performanceSummary(card: ScoreCard) {
  const rows = dimensionRows(card)
  const scored = rows.filter(row => row.scored)
  return { scored, insufficient: rows.length - scored.length }
}

/** A tool flag in words: the same work went poorly on one executor and well on another. */
export function toolFlagLines(card: ScoreCard) {
  return card.toolFlags.map(flag => t('employees.bole.performance.toolFlag', {
    dimension: dimensionLabel(flag.dimension),
    executor: flag.executorId,
    rate: percent(flag.rate),
    compared: flag.comparedExecutorId,
    comparedRate: percent(flag.comparedRate),
  }))
}
