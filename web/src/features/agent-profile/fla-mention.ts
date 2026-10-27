import type { ProjectAgentRecord } from '@/types'

// How a person calls one of their FLAs into a chat, as text to paste (rec#54,
// rec#55). Every phrasing is exactly what task entry parses
// (src/graphiti/fla-mention.js), checked in both locales by
// test/fla-mention-phrasings.test.js: `#FLA <name>` counts anywhere in a
// prompt, `@FLG …` only at its start. This module imports nothing at run time
// so that Node test can load it.

// FULI's own roles and task-only Agents are not FLAs (src/graphiti/fla-picker.js).
const ROLE_AGENT_IDS = new Set(['employee.assistant', 'employee.jefa', 'employee.bole', 'employee.tonborg', 'fuli-project-hr'])
const ROLE_CAPABILITIES = new Set(['fuli.employee:jefa', 'fuli.employee:bole', 'fuli.employee:tonborg'])
const NOT_FLA_TYPES = new Set(['coordinator', 'hr', 'temporary'])

export type MentionPhrasingKey = 'continue' | 'pair' | 'recommend'
/** `open` phrasings end where the person goes on typing (shown with a trailing …). */
export interface MentionPhrasing { key: MentionPhrasingKey; text: string; open: boolean }
type Translate = (key: MentionPhrasingKey, values: Record<string, string>) => string

/** Whether a person can call this Agent by name: an active FLA, not a FULI role. */
export function isMentionableFla(agent: Pick<ProjectAgentRecord, 'agentId' | 'profile'>) {
  const { agentType, status, capabilities } = agent.profile
  return status === 'active' && !NOT_FLA_TYPES.has(agentType ?? 'durable') && !ROLE_AGENT_IDS.has(agent.agentId)
    && !capabilities.some((value) => ROLE_CAPABILITIES.has(value.toLowerCase()))
}

/** The address the copy button puts on the clipboard. */
export function flaMention(name: string) {
  return `#FLA ${name}`
}

/** Ready-to-use phrasings; the pair one only when another FLA is known. */
export function mentionPhrasings(name: string, partner: string | null, translate: Translate): MentionPhrasing[] {
  return [
    { key: 'continue', text: `${flaMention(name)} ${translate('continue', { name })}`, open: false },
    ...(partner ? [{ key: 'pair' as const, text: `@FLG ${translate('pair', { name, partner })}`, open: true }] : []),
    { key: 'recommend', text: `@FLG ${translate('recommend', { name })}`, open: true },
  ]
}

/** What a copy puts on the clipboard: a trailing space keeps a Chinese name apart from what is typed next. */
export function clipboardText(text: string) {
  return `${text} `
}
