import type { ClientLinksManifest } from '@/features/client-links/model'
import { sourceApplication, sourceApplicationName, sourceLinkForEvidence } from '@/features/knowledge/source-adapters'
import type { ConversationLauncherConfiguration, ConversationSourceApplication, ProjectAgentTaskSession } from '@/types'

// The client marks at the end of a 正在干活 row: one per client the work runs
// in, and whether this console can open that session there. The link is the
// one 设置 › 会话打开方式 builds and only for a client the person turned on;
// whether the client opens anything at all comes from the client link list.
export const SHOWN_CLIENTS = 3

export type ClientMark = { client: ConversationSourceApplication; name: string } & (
  | { way: 'session'; href: string }
  /** The client has links of its own, but not to this session from here. */
  | { way: 'app' }
  /** Nothing opens this client. */
  | { way: 'none' }
)

/** A mark for each session with a known client, in the order given; an unknown client shows nothing. */
export function clientMarks(
  sessions: readonly ProjectAgentTaskSession[],
  launchers: ConversationLauncherConfiguration,
  manifest: ClientLinksManifest | null | undefined,
): ClientMark[] {
  return sessions.flatMap(({ client: reported, sessionId }): ClientMark[] => {
    const evidence = { source_application: reported, session_id: sessionId }
    const client = sourceApplication(evidence)
    if (client === 'other') return []
    const name = sourceApplicationName(client)
    const href = sourceLinkForEvidence(evidence, launchers)
    if (href) return [{ client, name, way: 'session', href }]
    const links = manifest?.clients.find(item => item.id === client)?.sessionLinks.length ?? 0
    return [{ client, name, way: links ? 'app' : 'none' }]
  })
}

// Two letters stand for each client; its name is the mark's accessible name and tooltip.
export const CLIENT_INITIALS: Record<ConversationSourceApplication, string> = {
  codex: 'Cx', claude: 'Cl', claude_code: 'CC', cursor: 'Cu', gemini_cli: 'Ge', kiro: 'Ki', opencode: 'OC', antigravity: 'AG', dsh: 'DS', other: '',
}
