import { employeeAvatarUrl } from '@/features/employees/avatars'
import { createAvatar } from '@/vendor/fuli-avatar/avatar.js'

// Identity is the stable Agent ID, never its editable name, job, project or status.
// The pinned renderer includes VERSION 3 in its seed. Nothing is stored or fetched.
export function agentAvatarUrl(agentId: string): string {
  return employeeAvatarUrl(agentId)
    ?? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createAvatar(agentId))}`
}
