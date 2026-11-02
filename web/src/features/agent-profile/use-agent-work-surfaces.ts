import { ref, type Ref } from 'vue'
import type { ProjectAgentRecord } from '@/types'
import { readAgentWorkSurfaces, type AgentWorkSurfaces } from './agent-work-surfaces'

export type SurfaceState =
  | { status: 'loading' }
  | { status: 'ready'; surfaces: AgentWorkSurfaces }
  | { status: 'error' }

/**
 * Reads each FLA's work surfaces once, on the first menu open, and keeps the
 * result (or the failure) for the rest of the console session. The dock's pins
 * and every portrait's right-click menu share this, so an FLA's surfaces are
 * read once, not once per menu.
 */
export function useAgentWorkSurfaces(spaceId: Ref<string>) {
  const surfaces = ref<Record<string, SurfaceState>>({})

  async function open(agent: ProjectAgentRecord) {
    const current = surfaces.value[agent.agentId]
    if (current?.status === 'ready' || current?.status === 'loading') return
    surfaces.value[agent.agentId] = { status: 'loading' }
    try {
      surfaces.value[agent.agentId] = {
        status: 'ready',
        surfaces: await readAgentWorkSurfaces(spaceId.value, agent),
      }
    } catch {
      surfaces.value[agent.agentId] = { status: 'error' }
    }
  }

  const ready = (agentId: string) => {
    const state = surfaces.value[agentId]
    return state?.status === 'ready' ? state.surfaces : null
  }

  return { surfaces, open, ready }
}
