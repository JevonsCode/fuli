import { inject, ref, watch, type InjectionKey, type Ref } from 'vue'

import { getJson, putJson } from '@/api/client'
import { i18n, t } from '@/i18n'
import type { ProjectAgentRecord } from '@/types'

import { useAgentRoster } from './useAgentRoster'

export interface AgentPinsResponse {
  revision: number
  agentIds: string[]
}

export interface AgentPinsState {
  agentIds: Ref<string[]>
  revision: Ref<number | null>
  loading: Ref<boolean>
  savingAgentId: Ref<string | null>
  error: Ref<string>
  load: (options?: { force?: boolean }) => Promise<void>
  setPinned: (agentId: string, pinned: boolean) => Promise<boolean>
}

export interface AgentRosterState {
  agents: Ref<ProjectAgentRecord[]>
  loading: Ref<boolean>
  error: Ref<string>
  load: () => Promise<void>
}

export const AGENT_PINS_KEY: InjectionKey<AgentPinsState> = Symbol('agent-pins')
export const AGENT_ROSTER_KEY: InjectionKey<AgentRosterState> = Symbol('agent-roster')

interface CachedPins {
  revision: number
  agentIds: string[]
}

const pendingLoadsBySpace = new Map<string, Promise<CachedPins>>()

const fallbackCopy = {
  loading: 'Reading pinned Agents…',
  saving: 'Saving Agent pin…',
  loadError: 'Pinned Agents are temporarily unavailable.',
  saveError: 'The Agent pin could not be saved.',
  conflictError: 'The pin list changed. Try again.',
} as const

export function agentPinsText(key: string, fallback: string) {
  const translationKey = `agentPins.${key}`
  return i18n.global.te(translationKey) ? t(translationKey) : fallback
}

function localizedCopy(key: keyof typeof fallbackCopy) {
  return agentPinsText(key, fallbackCopy[key])
}

function statusOf(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function parseResponse(value: unknown): CachedPins {
  const response = value && typeof value === 'object'
    ? value as Partial<AgentPinsResponse>
    : {}
  const agentIds = Array.isArray(response.agentIds)
    ? [...new Set(response.agentIds.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0))]
    : []
  return {
    revision: typeof response.revision === 'number' ? response.revision : 0,
    agentIds,
  }
}

function loadPins(spaceId: string) {
  const pending = pendingLoadsBySpace.get(spaceId)
  if (pending) return pending

  const request = getJson<AgentPinsResponse>(
    `/api/agent-pins?${new URLSearchParams({ personalSpaceId: spaceId })}`,
  ).then((value) => {
    const parsed = parseResponse(value)
    return parsed
  }).finally(() => {
    if (pendingLoadsBySpace.get(spaceId) === request) pendingLoadsBySpace.delete(spaceId)
  })
  pendingLoadsBySpace.set(spaceId, request)
  return request
}

export function useAgentPins(spaceId: Ref<string>): AgentPinsState {
  const agentIds = ref<string[]>([])
  const revision = ref<number | null>(null)
  const loading = ref(false)
  const savingAgentId = ref<string | null>(null)
  const error = ref('')
  const cachedPinsBySpace = new Map<string, CachedPins>()
  let generation = 0

  function clearState() {
    agentIds.value = []
    revision.value = null
    loading.value = false
    savingAgentId.value = null
    error.value = ''
  }

  function applyPins(value: CachedPins) {
    revision.value = value.revision
    agentIds.value = [...value.agentIds]
  }

  async function load(options: { force?: boolean } = {}) {
    const requestedSpace = spaceId.value
    const current = ++generation
    error.value = ''
    if (!requestedSpace) {
      clearState()
      return
    }
    const cached = !options.force ? cachedPinsBySpace.get(requestedSpace) : undefined
    if (cached) {
      applyPins(cached)
      loading.value = false
      return
    }
    loading.value = true
    try {
      const response = await loadPins(requestedSpace)
      cachedPinsBySpace.set(requestedSpace, response)
      if (current !== generation || spaceId.value !== requestedSpace) return
      applyPins(response)
    } catch {
      if (current === generation && spaceId.value === requestedSpace) {
        error.value = localizedCopy('loadError')
      }
    } finally {
      if (current === generation && spaceId.value === requestedSpace) loading.value = false
    }
  }

  async function setPinned(agentId: string, pinned: boolean) {
    const requestedSpace = spaceId.value
    if (!requestedSpace) return false
    if (revision.value === null) await load()
    if (spaceId.value !== requestedSpace || revision.value === null) return false

    const expectedRevision = revision.value
    savingAgentId.value = agentId
    error.value = ''
    try {
      const response = await putJson<AgentPinsResponse>('/api/agent-pins', {
        personalSpaceId: requestedSpace,
        agentId,
        pinned,
        expectedRevision,
      })
      const parsed = parseResponse(response)
      cachedPinsBySpace.set(requestedSpace, parsed)
      if (spaceId.value === requestedSpace) applyPins(parsed)
      return true
    } catch (cause) {
      if (spaceId.value !== requestedSpace) return false
      if (statusOf(cause) === 409) {
        await load({ force: true })
        if (spaceId.value === requestedSpace && !error.value) error.value = localizedCopy('conflictError')
      } else {
        error.value = localizedCopy('saveError')
      }
      return false
    } finally {
      if (spaceId.value === requestedSpace) savingAgentId.value = null
    }
  }

  watch(spaceId, () => {
    generation += 1
    clearState()
    if (spaceId.value) void load()
  }, { immediate: true })

  return { agentIds, revision, loading, savingAgentId, error, load, setPinned }
}

export function useAgentPinsState(spaceId: Ref<string>) {
  return inject(AGENT_PINS_KEY, null) ?? useAgentPins(spaceId)
}

export function useAgentRosterState(spaceId: Ref<string>): AgentRosterState {
  return inject(AGENT_ROSTER_KEY, null) ?? useAgentRoster(spaceId)
}
