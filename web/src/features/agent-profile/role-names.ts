import { getJson } from '@/api/client'
import { i18n, t } from '@/i18n'
import { roleNameMessages } from '@/i18n/messages/role-names'
import type { ProjectAgentRecord } from '@/types'
import { projectAgentShape } from './agent-record-shape'
import { agentDisplayName } from './profile-model'

// The names FULI's built-in roles go by now (rec#11 D-89). Copy names a role
// through the roleNames messages, so writing a role's current name there
// renames it in every label at once. The shell reads the four roles once per
// space; a rename through renameAgent writes the new name straight away.
export const ROLE_AGENT_IDS = {
  jefa: 'employee.jefa',
  bole: 'employee.bole',
  tonborg: 'employee.tonborg',
  astro: 'employee.assistant',
} as const
export type BuiltInRole = keyof typeof ROLE_AGENT_IDS
const ROLES = Object.keys(ROLE_AGENT_IDS) as BuiltInRole[]
const LOCALES = Object.keys(roleNameMessages) as (keyof typeof roleNameMessages)[]

/** The name a built-in role goes by now. */
export const roleName = (role: BuiltInRole) => t(`roleNames.${role}`)

/** The built-in role an Agent is, by its ID, or null. */
export function builtInRole(agentId: string): BuiltInRole | null {
  return ROLES.find(role => ROLE_AGENT_IDS[role] === agentId) ?? null
}

function write(names: Partial<Record<BuiltInRole, string>>) {
  for (const locale of LOCALES) {
    i18n.global.mergeLocaleMessage(locale, { roleNames: { ...roleNameMessages[locale], ...names } })
  }
}

/** Shows a built-in role by the name its record carries now; any other Agent is left alone. */
export function rememberRoleName(record: Pick<ProjectAgentRecord, 'agentId' | 'profile'>) {
  const role = builtInRole(record.agentId)
  if (role) write({ ...currentNames(), [role]: agentDisplayName(record as ProjectAgentRecord) })
}

const currentNames = () => Object.fromEntries(ROLES.map(role => [role, roleName(role)])) as Record<BuiltInRole, string>

let loadedSpace = ''

/** Reads the four roles' current names for a space; a role it cannot read keeps its own name. */
export async function loadRoleNames(spaceId: string): Promise<void> {
  if (!spaceId || spaceId === loadedSpace) return
  loadedSpace = spaceId
  write({})
  await Promise.all(ROLES.map(async (role) => {
    try {
      const record = await getJson(
        `/api/project-agents/${encodeURIComponent(ROLE_AGENT_IDS[role])}?${new URLSearchParams({ personalSpaceId: spaceId })}`,
        projectAgentShape,
      )
      if (spaceId === loadedSpace) rememberRoleName(record)
    } catch {
      // A role this space does not have, or a failed read, keeps the role's own name.
    }
  }))
}

/** Test seam: every role back to its own name, and no space loaded. */
export function forgetRoleNames() {
  loadedSpace = ''
  write({})
}
