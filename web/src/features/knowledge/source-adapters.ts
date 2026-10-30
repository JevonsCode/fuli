import { t } from '@/i18n'
import type {
  ConversationLauncherApplication,
  ConversationLauncherConfiguration,
  ConversationLauncherRule,
  ConversationSourceApplication,
  EvidenceRecord,
  SessionLaunchOffer,
} from '@/types'

export const CONVERSATION_SOURCE_APPLICATIONS: readonly ConversationLauncherApplication[] = [
  'codex',
  'claude',
  'claude_code',
  'cursor',
  'gemini_cli',
  'kiro',
  'other',
]

const APPLICATION_LABELS: Record<ConversationSourceApplication, string> = {
  codex: 'Codex',
  claude: 'Claude',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  gemini_cli: 'Gemini CLI',
  kiro: 'Kiro',
  opencode: 'OpenCode',
  other: 'Other Agent',
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_SESSION_ID = /^[^\u0000-\u001f\u007f]{1,512}$/
const BLOCKED_URL_SCHEMES = new Set(['about', 'blob', 'data', 'file', 'javascript'])

export type SourceLauncherStatus =
  | 'available'
  | 'disabled'
  | 'invalid_id'
  | 'invalid_template'

export const DEFAULT_CONVERSATION_LAUNCHERS: ConversationLauncherConfiguration = {
  codex: {
    enabled: true,
    idFormat: 'uuid',
    appName: 'Codex',
    urlTemplate: 'codex://threads/{id}',
  },
  claude: {
    enabled: false,
    idFormat: 'any',
    appName: 'Claude',
    urlTemplate: '',
  },
  claude_code: {
    enabled: false,
    idFormat: 'any',
    appName: 'Claude Code',
    urlTemplate: '',
  },
  cursor: {
    enabled: false,
    idFormat: 'any',
    appName: 'Cursor',
    urlTemplate: '',
  },
  gemini_cli: {
    enabled: false,
    idFormat: 'any',
    appName: 'Gemini CLI',
    urlTemplate: '',
  },
  kiro: {
    enabled: false,
    idFormat: 'any',
    appName: 'Kiro',
    urlTemplate: '',
  },
  other: {
    enabled: false,
    idFormat: 'any',
    appName: 'Other Agent',
    urlTemplate: '',
  },
}

export function sourceApplication(
  evidence: EvidenceRecord = {},
): ConversationSourceApplication {
  const application = evidence.source_application
    ?.trim()
    .toLocaleLowerCase()
    .replaceAll('-', '_')
    .replaceAll(' ', '_') as ConversationSourceApplication | undefined
  if (application && APPLICATION_LABELS[application]) return application
  const text = `${evidence.source_kind ?? ''} ${evidence.source_description ?? ''}`
    .toLocaleLowerCase()
  if (text.includes('claude')) return 'claude_code'
  if (text.includes('cursor')) return 'cursor'
  if (text.includes('gemini')) return 'gemini_cli'
  if (text.includes('kiro')) return 'kiro'
  if (text.includes('opencode')) return 'opencode'
  if (text.includes('codex')) return 'codex'
  return 'other'
}

// The key the session launch offers use for this evidence's session, or null without one.
export function sessionLaunchKey(evidence: EvidenceRecord = {}) {
  const sessionId = evidence.session_id?.trim()
  return sessionId ? `${sourceApplication(evidence)}:${sessionId}` : null
}

export function sourceApplicationLabel(evidence: EvidenceRecord) {
  const application = sourceApplication(evidence)
  return application === 'other'
    ? t('knowledge.domain.actors.otherAgent')
    : APPLICATION_LABELS[application]
}

export function sourceApplicationName(application: ConversationSourceApplication) {
  return APPLICATION_LABELS[application]
}

// offer: the session launcher's answer for this evidence's session, when the
// console has one; without it (or for 'fuli') the configured template decides.
export function sourceLinkForEvidence(
  evidence: EvidenceRecord = {},
  configuration: ConversationLauncherConfiguration = DEFAULT_CONVERSATION_LAUNCHERS,
  offer?: SessionLaunchOffer,
) {
  if (offer?.offer === 'link') return offer.href ?? null
  if (offer?.offer === 'none') return null
  if (sourceLauncherStatus(evidence, configuration) !== 'available') return null
  const rule = launcherRule(configuration, evidence)!
  const sessionId = evidence.session_id!.trim()
  return rule.urlTemplate.replace('{id}', encodeURIComponent(sessionId))
}

export function sourceLauncherStatus(
  evidence: EvidenceRecord = {},
  configuration: ConversationLauncherConfiguration = DEFAULT_CONVERSATION_LAUNCHERS,
): SourceLauncherStatus {
  const rule = launcherRule(configuration, evidence)
  if (!rule?.enabled) return 'disabled'
  const sessionId = evidence.session_id?.trim() ?? ''
  if (!safeSessionId(sessionId, rule.idFormat)) return 'invalid_id'
  if (!safeUrlTemplate(rule.urlTemplate)) return 'invalid_template'
  return 'available'
}

export function sourceLauncherAppName(
  evidence: EvidenceRecord = {},
  configuration: ConversationLauncherConfiguration = DEFAULT_CONVERSATION_LAUNCHERS,
) {
  const rule = launcherRule(configuration, evidence)
  return rule?.enabled && rule.appName.trim() ? rule.appName.trim() : null
}

// The launcher of the evidence's application, or undefined when it has none (OpenCode).
function launcherRule(configuration: ConversationLauncherConfiguration, evidence: EvidenceRecord): ConversationLauncherRule | undefined {
  const application = sourceApplication(evidence)
  return application === 'opencode' ? undefined : configuration[application]
}

export async function copySourceSession(
  evidence: EvidenceRecord = {},
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
) {
  if (!evidence.session_id || !clipboard?.writeText) return false
  await clipboard.writeText(evidence.session_id)
  return true
}

function safeSessionId(value: string, format: 'any' | 'uuid') {
  if (!SAFE_SESSION_ID.test(value)) return false
  return format === 'any' || THREAD_ID.test(value)
}

function safeUrlTemplate(value: string) {
  if (value.split('{id}').length !== 2 || /\s/.test(value)) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLocaleLowerCase()
  return Boolean(scheme) && !BLOCKED_URL_SCHEMES.has(scheme!)
}
