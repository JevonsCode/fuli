import type { ClientLinksManifest } from '@/features/client-links/model'
import { isOpenSheet } from '@/features/team-work/team-sheets'
import { clientMarks } from '@/features/today/working-clients'
import type { ConversationLauncherConfiguration, ConversationSourceApplication, ProjectAgentTaskRecord } from '@/types'

// 交给它一件事 (docs/fla-page.md, The one action): the client sessions the
// FLA's open FULI tasks report, and whether each opens.

/**
 * One row per client session an open task reports. A row opens the session
 * when 设置 › 会话打开方式 can build its link; otherwise it says why not:
 * `settings` — the client can open a session, this console was not set up to
 * (去设置 fixes it); `none` — nothing opens this client's sessions; `unknown`
 * — the client is known but not which conversation.
 */
export type SessionRow = { key: string; client: ConversationSourceApplication; name: string } & (
  | { way: 'session'; href: string }
  | { way: 'settings' | 'none' | 'unknown' }
)

export function sessionRows(
  tasks: readonly ProjectAgentTaskRecord[],
  launchers: ConversationLauncherConfiguration,
  manifest: ClientLinksManifest | null | undefined,
): SessionRow[] {
  const seen = new Set<string>()
  return tasks.filter(isOpenSheet).flatMap(task => task.sessions ?? []).flatMap((session): SessionRow[] => {
    const key = `${session.client}:${session.sessionId ?? ''}`
    if (seen.has(key)) return []
    seen.add(key)
    const [mark] = clientMarks([session], launchers, manifest)
    if (!mark) return []
    const row = { key, client: mark.client, name: mark.name }
    if (mark.way === 'session') return [{ ...row, way: 'session', href: mark.href }]
    if (!session.sessionId) return [{ ...row, way: 'unknown' }]
    return [{ ...row, way: mark.way === 'app' ? 'settings' : 'none' }]
  })
}

export type ClosedWhy = Exclude<SessionRow['way'], 'session'>

/**
 * The sessions that cannot open, as one note per reason in a fixed order
 * (the one 去设置 fixes first): the clients' names, then why. Rows that open
 * are listed on their own, not here.
 */
export function closedSessionNotes(rows: readonly SessionRow[], note: (clients: string, why: ClosedWhy) => string): Array<{ why: ClosedWhy; text: string }> {
  return (['settings', 'none', 'unknown'] as const).flatMap((key) => {
    const names = [...new Set(rows.filter(row => row.way === key).map(row => row.name))]
    return names.length ? [{ why: key, text: note(names.join(' · '), key) }] : []
  })
}
