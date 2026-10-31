import { t } from '@/i18n'
import type { CapturePolicy } from '@/types'

// One capture change an Agent asked for, as the console's confirmation page
// shows it (rec#5 C4-2, rec#11 D-16): FULI's sentence, the change setting by
// setting and the settings now. Only the person's confirm on that page applies it.
export type CaptureChangeSetting = 'enabled' | 'disabledSources' | 'capturedSources' | 'projectMode' | 'excludedProjectIds'
  | 'selectedProjectIds' | 'unregisteredDirectories'

export interface CaptureChangePreview {
  status: 'pending' | 'stale'
  preview: string
  sourceApplication: string
  sessionId: string | null
  createdAt: string
  expiresAt: string
  current: CapturePolicy
  changes: Array<{ setting: CaptureChangeSetting; before: unknown; after: unknown }>
}

const CLIENT_NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude', claude_code: 'Claude Code',
  cursor: 'Cursor', kiro: 'Kiro', opencode: 'OpenCode', antigravity: 'Antigravity' }
const SHOWN_SESSION_CHARACTERS = 8

export function clientName(source: string) {
  return CLIENT_NAMES[source] ?? t('capture.confirm.otherClient')
}

// A session is named by its first characters; the full ID stays in a title.
export function shortSession(sessionId: string | null) {
  if (!sessionId) return ''
  return sessionId.length > SHOWN_SESSION_CHARACTERS ? `${sessionId.slice(0, SHOWN_SESSION_CHARACTERS)}…` : sessionId
}

export function settingLabel(setting: CaptureChangeSetting) {
  return t(`capture.confirm.settings.${setting}`)
}

// One setting's value in the person's words; projects by the names they gave them.
export function settingValue(setting: CaptureChangeSetting, value: unknown, projectName: (id: string) => string) {
  if (setting === 'enabled') return t(value ? 'capture.confirm.values.on' : 'capture.confirm.values.off')
  if (setting === 'projectMode') return t(`capture.settings.modes.${String(value)}`)
  if (setting === 'unregisteredDirectories') {
    return t(value === 'skip' ? 'capture.confirm.values.skip' : 'capture.confirm.values.capture')
  }
  const items = Array.isArray(value) ? value.map(String) : []
  if (!items.length) return t('capture.confirm.values.none')
  return items.map(item => setting === 'disabledSources' || setting === 'capturedSources' ? clientName(item) : projectName(item)).join('、')
}
