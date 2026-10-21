import { ApiError, apiErrorReason } from '@/api/client'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import { currentLocale, t } from '@/i18n'
import type { CapturePolicy } from '@/types'

// The project layer of the capture settings as a page shows it (rec#5 C2, C4-1):
// the same rule FULI applies to every write, read from the settings it saved.
// The global and client switches are separate layers and never shown as a
// project's own switch.

export type ProjectMode = NonNullable<CapturePolicy['projectMode']>
export const PROJECT_MODES: readonly ProjectMode[] = ['all', 'all_except', 'selected']

export function projectMode(policy: CapturePolicy | null | undefined): ProjectMode {
  return policy?.projectMode ?? 'all'
}

export function projectRecorded(policy: CapturePolicy | null | undefined, projectId: string): boolean {
  const mode = projectMode(policy)
  if (mode === 'all_except') return !(policy?.excludedProjectIds ?? []).includes(projectId)
  if (mode === 'selected') return (policy?.selectedProjectIds ?? []).includes(projectId)
  return true
}

// The day a project stopped being recorded, for a project that is off now.
export function projectOffSinceDay(policy: CapturePolicy | null | undefined, projectId: string): string | null {
  if (projectRecorded(policy, projectId)) return null
  const since = policy?.projectsOffSince?.[projectId] ?? policy?.unlistedProjectsOffSince ?? null
  return since ? formatDateTime(since, currentLocale(), DATE_ONLY, { missing: '' }) : null
}

// Work outside every registered project is recorded unless the person chose otherwise.
export function recordsUnregisteredDirectories(policy: CapturePolicy | null | undefined): boolean {
  return (policy?.unregisteredDirectories ?? (projectMode(policy) === 'selected' ? 'skip' : 'capture')) === 'capture'
}

// What a failed save means for the settings shown (dot review, PR 262). A refusal (4xx)
// changed nothing. Any other failure may have saved, so the settings are read
// again before the page shows them; when that read fails too, the state is
// unknown and the page says so instead of claiming the old state is back.
export async function failedSaveMessage(error: unknown, reload: () => Promise<void>) {
  const reason = apiErrorReason(error)
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return t('capture.saveFailure.refused', { reason })
  }
  try {
    await reload()
    return t('capture.saveFailure.reread', { reason })
  } catch {
    return t('capture.saveFailure.unknown', { reason })
  }
}

// A batch choice as the change to send: only projects whose choice differs from the saved settings.
export function changedProjectSwitches(policy: CapturePolicy | null | undefined, chosen: Record<string, boolean>) {
  return Object.fromEntries(Object.entries(chosen).filter(([id, recorded]) => projectRecorded(policy, id) !== recorded))
}
