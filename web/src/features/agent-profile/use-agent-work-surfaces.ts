import { ref, type Ref } from 'vue'
import type { ProjectAgentRecord } from '@/types'
import { readAgentWorkSurfaces, type AgentWorkSurfaces } from './agent-work-surfaces'

export type SurfaceState =
  | { status: 'loading' }
  | { status: 'ready'; surfaces: AgentWorkSurfaces }
  | { status: 'error' }

/**
 * Reads an FLA's work surfaces each time its menu opens. A kept answer stays on
 * screen while the fresh one is read, so new work shows without a wait and an
 * old "nothing here" never sticks (rec#72); a failed first read says so and the
 * next open tries again. The dock's pins and the app's portrait menu
 * (AppContextMenu) each keep one.
 */
export function useAgentWorkSurfaces(spaceId: Ref<string>) {
  const surfaces = ref<Record<string, SurfaceState>>({})
  const reading = new Set<string>()

  async function open(agent: ProjectAgentRecord) {
    if (reading.has(agent.agentId)) return
    reading.add(agent.agentId)
    const kept = surfaces.value[agent.agentId]?.status === 'ready'
    if (!kept) surfaces.value[agent.agentId] = { status: 'loading' }
    try {
      surfaces.value[agent.agentId] = {
        status: 'ready',
        surfaces: await readAgentWorkSurfaces(spaceId.value, agent),
      }
    } catch {
      if (!kept) surfaces.value[agent.agentId] = { status: 'error' }
    } finally {
      reading.delete(agent.agentId)
    }
  }

  const ready = (agentId: string) => {
    const state = surfaces.value[agentId]
    return state?.status === 'ready' ? state.surfaces : null
  }

  return { surfaces, open, ready }
}
