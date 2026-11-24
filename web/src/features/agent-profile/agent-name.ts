import { t } from '@/i18n'

/**
 * An FLA's name as a person reads it. A name someone gave stays as it is. Two
 * kinds of names FULI wrote by itself say nothing to a person, so the console
 * writes them in its own language instead:
 *
 * - the lead FULI hired for a project nobody named: '<generated project name>
 *   负责人' before graph/23 ('会话项目 / Conversation project 负责人'), and
 *   '#<number> 负责人' after it;
 * - a specialist recruited without a name: '<work_kind> Agent', an internal
 *   code such as 'code_review Agent', shown by its occupation instead.
 *
 * The stored name stays, since `#FLA <name>` reaches the FLA by it. Node writes
 * the same names the same way (src/graphiti/agent-display-name.js).
 */

const GENERATED_PROJECT = '(?:会话项目 / Conversation project|临时任务 / Temporary task|临时会话 / Temporary session)'
const TEMPORARY_LEAD = new RegExp(`^${GENERATED_PROJECT}\\s*负责人$`, 'u')
const NUMBERED_LEAD = /^#([0-9a-f]{8}) 负责人$/u
const WORK_KIND_AGENT = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)* Agent$/u

/** Whether FULI wrote this FLA name by itself. */
export function isGeneratedAgentName(name: string | null | undefined) {
  const text = (name ?? '').trim()
  return TEMPORARY_LEAD.test(text) || NUMBERED_LEAD.test(text) || WORK_KIND_AGENT.test(text)
}

/**
 * The name to show for a stored FLA name. `occupation` is the FLA's
 * occupation already in the console's language, where the caller has it.
 */
export function shownAgentName(name: string | null | undefined, occupation?: string | null) {
  const text = (name ?? '').trim()
  if (TEMPORARY_LEAD.test(text)) return t('agentProfiles.generatedName.temporaryLead')
  const numbered = NUMBERED_LEAD.exec(text)
  if (numbered) return t('agentProfiles.generatedName.numberedLead', { number: numbered[1]! })
  if (WORK_KIND_AGENT.test(text)) {
    return occupation ? t('agentProfiles.generatedName.occupation', { occupation }) : t('agentProfiles.generatedName.specialist')
  }
  return text
}
