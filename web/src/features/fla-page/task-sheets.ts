import { getJson } from '@/api/client'

// rec#11 D-82: an FLA's task sheets, one per task it takes part in. Progress
// is the stored plan's own count; without a plan it is null and the console
// shows no bar and no number, only the status.
export interface TaskSheetProgress { completed: number; total: number }
export interface TaskSheetShare {
  agentId: string
  role: string | null
  status: string
  assignment: string | null
  progress: TaskSheetProgress | null
}
export interface TaskSheet {
  taskId: string
  personalProjectId: string | null
  title: string
  objective: string | null
  status: string
  leadAgentId: string | null
  role: 'lead' | 'collaborator' | 'coordinator' | null
  updatedAt: string | null
  blocker: { summary?: string | null } | null
  progress: TaskSheetProgress | null
  steps: { id: string; title: string; status: string; agentId?: string | null }[]
  unassignedSteps: number
  shares: TaskSheetShare[]
}
export interface TaskSheets { agentId: string; partial: boolean; workbenches: TaskSheet[] }

export const readTaskSheets = (personalSpaceId: string, agentId: string, signal?: AbortSignal) =>
  getJson<TaskSheets>(`/api/project-agents/${encodeURIComponent(agentId)}/workbenches?${new URLSearchParams({ personalSpaceId })}`, { signal })

/** The lead reads its sheet in the recorded order; anyone else finds their own share first. */
export function sharesFor(sheet: TaskSheet, agentId: string): TaskSheetShare[] {
  if (sheet.leadAgentId === agentId) return sheet.shares
  const own = sheet.shares.filter(share => share.agentId === agentId)
  return [...own, ...sheet.shares.filter(share => share.agentId !== agentId)]
}

/** A share's bar fill, 0–1, or null when its progress is not recorded. */
export const shareFill = (progress: TaskSheetProgress | null) => progress && progress.total > 0 ? progress.completed / progress.total : null
