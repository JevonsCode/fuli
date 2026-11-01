import type { ProjectAgentRecord } from '@/types'

// How a person calls one of their Agents into a chat, as text to paste (rec#54,
// rec#55, rec#58). Every phrasing is exactly what task entry parses
// (src/graphiti/fla-mention.js), checked in both locales by
// test/fla-by-name.test.js and test/flg-entry.test.js: `#FLA <name>` at the
// start (or right after a request word such as 请/让/帮我), `@FLG …` only at
// its start. This module imports nothing at run time so that Node test can load it.

// FULI's built-in roles: called alone by name with `#FLA <name>` (rec#58),
// never a group member (src/graphiti/fla-picker.js roleCandidates).
const BUILT_IN_ROLE_IDS = new Set(['employee.assistant', 'employee.jefa', 'employee.bole', 'employee.tonborg'])
// Not FLAs: the built-in roles and the retired AR identity.
const ROLE_AGENT_IDS = new Set([...BUILT_IN_ROLE_IDS, 'fuli-project-hr'])
const ROLE_CAPABILITIES = new Set(['fuli.employee:jefa', 'fuli.employee:bole', 'fuli.employee:tonborg'])
const NOT_FLA_TYPES = new Set(['coordinator', 'hr', 'temporary'])

/** Whether this Agent is one of FULI's built-in roles, which keep their own name for `#FLA` when renamed. */
export const isBuiltInRole = (agentId: string) => BUILT_IN_ROLE_IDS.has(agentId)

/** 'fla': alone or in a group; 'role': a built-in role, alone only. */
export type MentionKind = 'fla' | 'role'
export type MentionPhrasingKey = 'continue' | 'pair' | 'recommend' | 'discuss' | 'relay'
/** `open` phrasings end where the person goes on typing (shown with a trailing …). */
export interface MentionPhrasing { key: MentionPhrasingKey; text: string; open: boolean }
type Translate = (key: MentionPhrasingKey, values: Record<string, string>) => string
type Mentionable = Pick<ProjectAgentRecord, 'agentId' | 'profile'>

/** Whether this Agent is an active FLA: callable by name and a group member, not a FULI role. */
export function isMentionableFla(agent: Mentionable) {
  const { agentType, status, capabilities } = agent.profile
  return status === 'active' && !NOT_FLA_TYPES.has(agentType ?? 'durable') && !ROLE_AGENT_IDS.has(agent.agentId)
    && !capabilities.some((value) => ROLE_CAPABILITIES.has(value.toLowerCase()))
}

/** How a person can call this Agent by name, or null when they cannot. */
export function mentionKind(agent: Mentionable): MentionKind | null {
  if (isMentionableFla(agent)) return 'fla'
  const builtIn = BUILT_IN_ROLE_IDS.has(agent.agentId)
    && agent.profile.capabilities.includes(`fuli.employee:${agent.agentId.slice('employee.'.length)}`)
  return builtIn && agent.profile.status === 'active' ? 'role' : null
}

/** The address the copy button puts on the clipboard. */
export function flaMention(name: string) {
  return `#FLA ${name}`
}

/** Ready-to-use phrasings; the group ones only for an FLA, the pair one only when another FLA is known. */
export function mentionPhrasings(name: string, partner: string | null, translate: Translate, kind: MentionKind = 'fla'): MentionPhrasing[] {
  const alone: MentionPhrasing = { key: 'continue', text: `${flaMention(name)} ${translate('continue', { name })}`, open: false }
  if (kind === 'role') return [alone]
  return [
    alone,
    ...(partner ? [{ key: 'pair' as const, text: `@FLG ${translate('pair', { name, partner })}`, open: true }] : []),
    { key: 'recommend', text: `@FLG ${translate('recommend', { name })}`, open: true },
  ]
}

/**
 * How a person gets their FLAs talking to each other (the 圆桌 helper): a
 * discussion that recommends 2–4 members, two named FLAs discussing, one FLA
 * asked to ask another (an inline `#FLA` after 让 / ask, then message_agent),
 * and one FLA continuing here. `names` are two of the person's FLAs, when known.
 */
export function conversationPhrasings(names: readonly string[], translate: Translate): MentionPhrasing[] {
  const [name, partner] = names
  return [
    { key: 'discuss', text: `@FLG ${translate('discuss', {})}`, open: true },
    ...(name && partner ? [
      { key: 'pair' as const, text: `@FLG ${translate('pair', { name, partner })}`, open: true },
      { key: 'relay' as const, text: translate('relay', { mention: flaMention(name), partner }), open: true },
    ] : []),
    ...(name ? [{ key: 'continue' as const, text: `${flaMention(name)} ${translate('continue', { name })}`, open: false }] : []),
  ]
}

/** What a copy puts on the clipboard: a trailing space keeps a Chinese name apart from what is typed next. */
export function clipboardText(text: string) {
  return `${text} `
}
