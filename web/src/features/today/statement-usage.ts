import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { sourceApplication, sourceApplicationName } from '@/features/knowledge/source-adapters'
import { currentLocale, t } from '@/i18n'
import type { ConversationSourceApplication } from '@/types'
import type { StatementWeek } from './statement'

// 用了哪些客户端和模型: GET /api/statement/usage for one week. Each row is a
// client and the model it reported (null: none did); task entries and woken
// answers are what FULI saw, tokens only what a client reported. Nothing here
// is estimated, and a failed read shows nothing.
const count = z.number()
const usageSchema = z.looseObject({
  rows: z.array(z.looseObject({
    client: z.string(),
    model: z.string().nullable(),
    taskEntries: count,
    wakes: count,
    tokens: z.looseObject({ input: count.nullable(), output: count.nullable(), answers: count }).nullable(),
  })),
  more: z.boolean(),
})
const usageShape = shapeOf(usageSchema)
export type StatementUsage = z.infer<typeof usageSchema>

/** The week's clients and models, or null when the server cannot give them. */
export async function readStatementUsage(week: StatementWeek): Promise<StatementUsage | null> {
  try {
    return await getJson(`/api/statement/usage?${new URLSearchParams({ from: week.from, to: week.to })}`, usageShape)
  } catch {
    return null
  }
}

export interface UsageRow { key: string; client: ConversationSourceApplication; clientName: string; model: string; counts: string; source: string }

/** One line per client and model with its counts and who saw them; rows with nothing to count are left out. */
export function usageRows(usage: StatementUsage | null): UsageRow[] {
  return (usage?.rows ?? []).filter(row => row.taskEntries || row.wakes).map((row) => {
    const client = sourceApplication({ source_application: row.client })
    const tokens = reportedTokens(row.tokens)
    return {
      key: `${row.client}\u0000${row.model ?? ''}`,
      client,
      clientName: client === 'other' ? t('today.usage.otherClient') : sourceApplicationName(client),
      model: row.model ?? t('today.usage.unknownModel'),
      counts: [row.taskEntries ? t('today.usage.entries', { count: row.taskEntries }) : '',
        row.wakes ? t('today.usage.wakes', { count: row.wakes }) : '',
        tokens === null ? '' : t('today.usage.tokens', { count: tokens })].filter(Boolean).join(' · '),
      source: tokens === null ? t('today.statement.source.seen')
        : t('today.usage.tokensSource', { seen: t('today.statement.source.seen'), answers: row.tokens?.answers ?? 0 }),
    }
  })
}

// Input and output the clients reported, added; null unless both were reported, so no total is a partial one.
function reportedTokens(tokens: StatementUsage['rows'][number]['tokens']) {
  if (!tokens || tokens.input === null || tokens.output === null) return null
  return new Intl.NumberFormat(currentLocale()).format(tokens.input + tokens.output)
}
