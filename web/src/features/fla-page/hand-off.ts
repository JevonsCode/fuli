import type { ClientLinksManifest } from '@/features/client-links/model'
import { isOpenSheet } from '@/features/team-work/team-sheets'
import { clientMarks } from '@/features/today/working-clients'
import type { ConversationLauncherConfiguration, ConversationSourceApplication, ProjectAgentTaskRecord } from '@/types'

// 交给它一件事 (docs/fla-page.md, The one action): what the panel lists
// besides the phrases to paste. Only open FULI tasks, and only the client
// sessions those tasks report.
export interface OpenWork { taskId: string; title: string; status: string }

/** The unfinished tasks to continue, newest change first. */
export function openWork(tasks: readonly ProjectAgentTaskRecord[]): OpenWork[] {
  return tasks.filter(isOpenSheet)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .map(({ taskId, title, status }) => ({ taskId, title, status }))
}

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
