import { computed, type Ref } from 'vue'
import { readFlaKit, type OccupationKit } from '@/features/occupation-kits/occupation-kits'
import { sharedRead } from '@/lib/shared-read'

// One read of an FLA's starter kit, shared by its section (fla-kit) and the
// 等你处理 line under 现在. A failed read shows nothing, as before.
const kits = sharedRead((key, signal) => readFlaKit(key[0]!, key[1]!, signal))
export const forgetFlaKits = kits.forget

export function useFlaKit(spaceId: Ref<string>, agentId: Ref<string>) {
  const read = kits.use(computed(() => [spaceId.value, agentId.value]))
  return { kit: read.value, set: read.set, reload: read.reload }
}

/**
 * What the person still has to answer in a kit: every recommendation while
 * nothing was chosen, the ones never answered since, and a choice made for an
 * older version of the kit. Null when nothing waits.
 */
export function kitPending(kit: OccupationKit | null): { count: number; outdated: boolean } | null {
  if (!kit?.plugin) return null
  const items = [...(kit.skills ?? []), ...(kit.mcpServers ?? [])]
  const count = kit.choice ? items.filter(item => item.enabled === null).length : items.length
  const outdated = Boolean(kit.choice?.outdated)
  return count || outdated ? { count, outdated } : null
}
