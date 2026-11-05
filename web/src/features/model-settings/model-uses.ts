import { t } from '@/i18n'
import { modelGuideUrl, roleName, type ModelRoleId, type ModelRoleView, type ModelRolesPayload } from './model'

// The model center (11-06): every connected model once with who uses
// it, and every use with the capability that is enough for it. A use is a
// role (an Agent or 语义搜索) or one of Astro's tasks, which run on Astro's
// model when Astro's settings allow them.
const ASTRO_TASKS = ['dreaming', 'retrieval_terms'] as const
type AstroTask = typeof ASTRO_TASKS[number]
export type ModelUseId = ModelRoleId | AstroTask
type UseState = ModelRoleView['state']

const isTask = (use: ModelUseId): use is AstroTask => (ASTRO_TASKS as readonly string[]).includes(use)

export const useName = (use: ModelUseId) => (use === 'dreaming' ? 'Dreaming'
  : use === 'retrieval_terms' ? t('modelSettings.retrievalTerms.title') : roleName(use))

/** The one line that says what model is enough for a use; the guide explains it. */
export const useAdvice = (use: ModelUseId) => t(`modelSettings.uses.advice.${use}`)

/** The role whose model and details a use opens: an Astro task opens Astro. */
export const useRole = (use: ModelUseId): ModelRoleId => (isTask(use) ? 'assistant' : use)

// The website guide's section for each use (site/models/index.html ids).
const GUIDE_SECTIONS: Record<ModelUseId, string> = {
  semantic: 'semantic-search', assistant: 'astro', dreaming: 'dreaming', retrieval_terms: 'astro', jefa: 'jefa', tonborg: 'tonborg', bole: 'bole',
}
export const useGuideUrl = (use: ModelUseId, locale: string) => `${modelGuideUrl(locale)}#${GUIDE_SECTIONS[use]}`

export const stateTone = (state: UseState) => (state === 'enabled' ? 'success' : state === 'invalid_config' ? 'warning' : 'secondary')

/** An Astro task is on when Astro's model is on and its settings allow the task. */
export function taskState(payload: ModelRolesPayload, task: AstroTask): UseState {
  const astro = payload.roles.find(view => view.role === 'assistant')
  if (!astro || astro.state === 'not_configured' || astro.state === 'invalid_config') return astro?.state ?? 'not_configured'
  return astro.state === 'enabled' && astro.allowedOperations?.includes(task) ? 'enabled' : 'disabled'
}

export interface ModelInUse {
  id: string
  model: string
  service: string
  uses: { use: ModelUseId; on: boolean }[]
}

/** Each connection a role names, once, with the uses on it; a use that is off stays listed, marked off. */
export function modelsInUse(payload: ModelRolesPayload): ModelInUse[] {
  const models = new Map<string, ModelInUse>()
  for (const view of payload.roles) {
    const connection = view.connection
    if (!connection) continue
    const entry = models.get(connection.id) ?? { id: connection.id, model: connection.model,
      service: `${t(`modelSettings.protocols.${connection.protocol}`)} · ${connection.endpointHost}`, uses: [] }
    entry.uses.push({ use: view.role, on: view.state === 'enabled' })
    if (view.role === 'assistant') {
      for (const task of ASTRO_TASKS) if (view.allowedOperations?.includes(task)) entry.uses.push({ use: task, on: view.state === 'enabled' })
    }
    models.set(connection.id, entry)
  }
  return [...models.values()]
}
