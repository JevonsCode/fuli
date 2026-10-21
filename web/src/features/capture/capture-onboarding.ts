import type { CapturePolicy, CaptureScopeChoice } from '@/types'

// Which first-run answer saved settings amount to (rec#5 C10), so a console
// that lost an answer's response can say what the server actually holds; null
// for settings none of the three answers produce (changed elsewhere since).
export function savedCaptureScope(policy: CapturePolicy | undefined): CaptureScopeChoice | null {
  if (!policy) return null
  if (!policy.enabled) return 'off'
  if ((policy.projectMode ?? 'all') === 'all') return 'all'
  return policy.projectMode === 'selected' ? 'selected' : null
}
