import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// The four verification states (rec#78) the server derives from records only:
// a verifier's tests, Tonborg's acceptance, the person. The page never sets one.
const evidenceSchema = z.looseObject({
  state: z.string(),
  source: z.string(),
  ref: z.string(),
  refs: z.array(z.string()).optional(),
  at: z.string().nullish(),
})
export const verificationSchema = z.looseObject({
  state: z.enum(['person_confirmed', 'auto_verified', 'ai_assessed', 'unverified']),
  evidence: z.array(evidenceSchema),
})
const taskShape = shapeOf(verificationSchema)

export type Verification = z.infer<typeof verificationSchema>

export const readTaskVerification = (personalSpaceId: string, personalProjectId: string, taskId: string) =>
  getJson(`/api/project-agent-tasks/${encodeURIComponent(taskId)}/verification?${new URLSearchParams({ personalSpaceId, personalProjectId })}`, taskShape)

export const stateLabel = (value: Verification) => t(`verification.states.${value.state}`)

/** What the state rests on, one short line: the person, how many test evidence refs, Tonborg. */
export function evidenceLine(value: Verification) {
  const tests = value.evidence.filter(entry => entry.source === 'verification').reduce((sum, entry) => sum + (entry.refs?.length ?? 0), 0)
  return [
    ...(value.evidence.some(entry => entry.source === 'person') ? [t('verification.sources.person')] : []),
    ...(tests ? [t('verification.sources.verification', { count: tests })] : []),
    ...(value.evidence.some(entry => entry.source === 'tonborg') ? [t('verification.sources.tonborg')] : []),
  ].join(' · ')
}
