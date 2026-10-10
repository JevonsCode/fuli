export type JudgmentMode = 'manual' | 'shared' | 'autonomous'
export type JudgmentQuality = 'quality' | 'balanced' | 'economy'
export type JudgmentClient = 'codex' | 'claude_code'
export type JudgmentOutcome = 'approve' | 'escalate' | 'recommend' | 'failed'
export type JudgmentKind = 'review' | 'routing' | 'acceptance'
export type JudgmentExecutionStatus = 'not_applied' | 'applied' | 'stale' | 'failed'
export type JudgmentFeedbackVote = 'up' | 'down' | null

export interface JudgmentPolicySelection {
  mode: JudgmentMode
  quality: JudgmentQuality
  client: JudgmentClient
}

export interface JudgmentPolicy extends JudgmentPolicySelection {
  revision: number
  globalRevision: number
  inherited: boolean
  personalProjectId: string | null
}

export interface JudgmentProjectOption {
  id: string
  name: string
}

export interface JudgmentFeedback {
  revision: number
  vote: JudgmentFeedbackVote
  reason: string
}

export interface JudgmentExecution {
  status: JudgmentExecutionStatus
  receipt?: unknown
}

export interface JudgmentSelection {
  executorId: string
  model: string
  client: string
}

export interface JudgmentDecisionRecord {
  id: string
  createdAt: string
  personalProjectId: string | null
  kind: JudgmentKind
  target: string
  title?: string
  objective?: string
  summary: string
  outcome: JudgmentOutcome
  evidence: string[]
  policy: Partial<JudgmentPolicySelection> | null
  client?: JudgmentClient | null
  model?: string | null
  sessionId?: string | null
  error?: unknown
  selection?: JudgmentSelection | null
  disposition?: 'continue_current' | 'reuse_conversation' | 'new_session' | 'delegate' | 'ask_user'
  conversationId?: string | null
  execution: JudgmentExecution
  feedback: JudgmentFeedback
  feedbackHistory: unknown[]
  executionHistory: unknown[]
}

export interface JudgmentReviewResult {
  records: JudgmentDecisionRecord[]
  remaining: number
}

export const DEFAULT_JUDGMENT_POLICY: JudgmentPolicySelection = {
  mode: 'manual',
  quality: 'quality',
  client: 'codex',
}

export function isJudgmentMode(value: unknown): value is JudgmentMode {
  return value === 'manual' || value === 'shared' || value === 'autonomous'
}

export function isJudgmentQuality(value: unknown): value is JudgmentQuality {
  return value === 'quality' || value === 'balanced' || value === 'economy'
}

export function isJudgmentClient(value: unknown): value is JudgmentClient {
  return value === 'codex' || value === 'claude_code'
}

export function normalizeJudgmentPolicy(value: unknown, fallback: JudgmentPolicy = {
  ...DEFAULT_JUDGMENT_POLICY,
  revision: 0,
  globalRevision: 0,
  inherited: false,
  personalProjectId: null,
}): JudgmentPolicy {
  if (!value || typeof value !== 'object') return fallback
  const source = value as Partial<JudgmentPolicy>
  return {
    mode: isJudgmentMode(source.mode) ? source.mode : fallback.mode,
    quality: isJudgmentQuality(source.quality) ? source.quality : fallback.quality,
    client: isJudgmentClient(source.client) ? source.client : fallback.client,
    revision: typeof source.revision === 'number' ? source.revision : fallback.revision,
    globalRevision: typeof source.globalRevision === 'number' ? source.globalRevision : fallback.globalRevision,
    inherited: source.inherited === true,
    personalProjectId: typeof source.personalProjectId === 'string' ? source.personalProjectId : null,
  }
}

export function policySelection(policy: JudgmentPolicy): JudgmentPolicySelection {
  return { mode: policy.mode, quality: policy.quality, client: policy.client }
}

export function isHumanNeeded(record: JudgmentDecisionRecord): boolean {
  return record.outcome === 'escalate'
    || record.outcome === 'failed'
    || record.execution.status === 'not_applied' && record.policy?.mode === 'manual'
    || record.execution.status === 'stale'
    || record.execution.status === 'failed'
}
