import { t } from '@/i18n'
import { connectionService, formatCount, localBuildText, SEMANTIC_ROLE, trustStatusText, type ModelRoleView, type ModelRolesPayload } from './model'

// What a use's 「查看详情」 dialog lists of its role (rec#8, rec#38): who
// answers, the service, model, key reference, egress, limits and fallback,
// one uniform label-and-value list. 语义搜索 has no task types, budget or
// session to fall back to, so it lists only what its form edits.
export type RoleFact = { key: string; label: string; value: string; code?: boolean; title?: string }

const SEMANTIC_FACTS = new Set(['provider', 'model', 'localBuild', 'secretRef', 'egress'])

// A role its own model does not answer only suggests; one it answers shows its trust section instead.
export const showsTrust = (view: ModelRoleView) => Boolean(view.trust) && view.answeredBy === 'model_api'

/** A role that waits for the person: a warning not yet read, or a configuration that does not validate. */
export const needsPerson = (view: ModelRoleView) =>
  view.state === 'invalid_config' || Boolean(view.trust && showsTrust(view) && !view.trust.warningSeen)

export function roleFacts(view: ModelRoleView, payload: ModelRolesPayload, locale: string): RoleFact[] {
  const count = (value: number | null) => (value === null ? t('modelSettings.noLimit') : formatCount(value, locale))
  const answer = { key: 'answeredBy', label: t('modelSettings.answeredBy'),
    value: view.answeredBy ? t(`modelSettings.answer.${view.answeredBy}`) : t('modelSettings.none') }
  if (!view.connection) return [answer, ...trustFact(view)]
  const { budget, egress, connection } = view
  const currency = payload.connections[connection.id]?.pricing?.currency ?? ''
  const window = budget ? (budget.maxTokensPerWindow === null ? t('modelSettings.noLimit')
    : t('modelSettings.windowBudgetValue', { hours: count(budget.windowHours), tokens: count(budget.maxTokensPerWindow) }))
    + (budget.maxCostPerWindow === null ? '' : ` · ${t('modelSettings.costCap', { amount: budget.maxCostPerWindow, currency })}`) : t('modelSettings.none')
  const facts: RoleFact[] = [
    answer,
    { key: 'provider', label: t('modelSettings.provider'), value: connectionService(connection) },
    { key: 'model', label: t('modelSettings.model'), value: connection.model, code: true },
    ...localBuildFact(view, locale),
    { key: 'secretRef', label: t('modelSettings.secretRef'), value: connection.secretRef ?? t('modelSettings.none'), code: Boolean(connection.secretRef) },
    { key: 'operations', label: t('modelSettings.operations'), value: view.allowedOperations?.join(', ') || t('modelSettings.none'), code: Boolean(view.allowedOperations?.length) },
    { key: 'egress', label: t('modelSettings.egress'), value: egress
      ? [t('modelSettings.egressProjects', { count: egress.approvedProjects.length }), egress.allowUnassigned ? t('modelSettings.egressUnassigned') : ''].filter(Boolean).join(' · ')
      : t('modelSettings.none') },
    { key: 'callBudget', label: t('modelSettings.callBudget'), value: !budget ? t('modelSettings.none')
      : budget.maxInputTokens === null && budget.maxOutputTokens === null ? t('modelSettings.noLimit')
        : t('modelSettings.callBudgetValue', { input: count(budget.maxInputTokens), output: count(budget.maxOutputTokens),
          seconds: count(budget.timeoutMs === null ? null : budget.timeoutMs / 1000) }) },
    { key: 'windowBudget', label: t('modelSettings.windowBudget'), value: window },
    { key: 'fallback', label: t('modelSettings.fallback'), value: view.fallbackToSession ? t('modelSettings.allowed') : t('modelSettings.notAllowed') },
    ...trustFact(view),
  ]
  return view.role === SEMANTIC_ROLE ? facts.filter(fact => SEMANTIC_FACTS.has(fact.key)) : facts
}

function localBuildFact(view: ModelRoleView, locale: string): RoleFact[] {
  const build = localBuildText(view.localBuild, locale)
  return build ? [{ key: 'localBuild', label: t('modelSettings.localBuild.label'), value: build.text, code: build.code, title: build.title }] : []
}

function trustFact(view: ModelRoleView): RoleFact[] {
  if (!view.trust || showsTrust(view)) return []
  return [{ key: 'execution', label: t('modelSettings.trust.label'), value: trustStatusText(view.trust, null) }]
}
