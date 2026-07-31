import { t } from '@/i18n'
import type { EvidenceRecord } from '@/types'

const APPLICATION_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  kiro: 'Kiro',
  other: 'Other Agent',
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sourceApplication(evidence: EvidenceRecord = {}) {
  const application = evidence.source_application
  if (application && APPLICATION_LABELS[application]) return application
  const text = `${evidence.source_kind ?? ''} ${evidence.source_description ?? ''}`
    .toLocaleLowerCase()
  if (text.includes('claude')) return 'claude_code'
  if (text.includes('cursor')) return 'cursor'
  if (text.includes('kiro')) return 'kiro'
  if (text.includes('codex')) return 'codex'
  return 'other'
}

export function sourceApplicationLabel(evidence: EvidenceRecord) {
  const application = sourceApplication(evidence)
  return application === 'other'
    ? t('knowledge.domain.actors.otherAgent')
    : APPLICATION_LABELS[application]
}

export function sourceLinkForEvidence(evidence: EvidenceRecord = {}) {
  if (
    sourceApplication(evidence) !== 'codex'
    || !THREAD_ID.test(evidence.session_id ?? '')
  ) {
    return null
  }
  return `codex://threads/${evidence.session_id}`
}

export async function copySourceSession(
  evidence: EvidenceRecord = {},
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
) {
  if (!evidence.session_id || !clipboard?.writeText) return false
  await clipboard.writeText(evidence.session_id)
  return true
}
