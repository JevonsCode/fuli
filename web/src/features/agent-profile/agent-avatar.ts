import { employeeAvatarUrl } from '@/features/employees/avatars'
import { motionReduced } from '@/lib/motion-preference'
import { createAvatar } from '@/vendor/fuli-avatar/avatar.js'
import { agentLooks } from './agent-looks'

// Identity is the stable Agent ID, never its editable name, job, project or status.
// The pinned renderer (fuli-avatar 0.5.0) includes VERSION 5 in its seed. Portraits
// with an egg move (Jevons 11-01) and stand still when motion is reduced: the setting
// cannot reach inside an image.
const drawn = (seed: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createAvatar(seed, { eggs: true, animate: !motionReduced() }))}`

/** The look an Agent has when the person never changed it: its built-in portrait or its own drawing. */
export function defaultAvatarUrl(agentId: string): string {
  return employeeAvatarUrl(agentId) ?? drawn(agentId)
}

/** A drawing from another seed: what a re-roll shows before and after it is saved. */
export const generatedAvatarUrl = drawn

/** The picture an Agent shows now. Reading the shared looks makes every caller update when one changes. */
export function agentAvatarUrl(agentId: string): string {
  const look = agentLooks.value.get(agentId)
  if (look?.kind === 'image') {
    return `/api/agent-avatars/${encodeURIComponent(agentId)}/image?${new URLSearchParams({ v: look.imageVersion })}`
  }
  if (look?.kind === 'generated') return drawn(look.seed)
  return defaultAvatarUrl(agentId)
}
