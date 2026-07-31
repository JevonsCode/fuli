import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import { getJson, patchJson } from '@/api/client'
import { t } from '@/i18n'
import type {
  AgentAccessPolicy,
  CapabilityName,
  CapturePolicy,
  ConsoleState,
} from '@/types'

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'error'
export type FeedbackTone = 'success' | 'error'

export const useConsoleStore = defineStore('console', () => {
  const state = shallowRef<ConsoleState | null>(null)
  const runtimeStatus = ref<RuntimeStatus>('idle')
  const feedback = ref<{ message: string; tone: FeedbackTone } | null>(null)

  const activePersonalSpace = computed(() => {
    const value = state.value
    if (!value) return null
    return value.personalSpaces.find(({ id }) => id === value.activePersonalSpaceId)
      ?? value.personalSpaces[0]
      ?? null
  })

  const publicRuntimeStatus = computed(() => {
    if (state.value?.mode === 'connected') return 'ready'
    if (state.value?.mode === 'degraded') return 'error'
    return 'disconnected'
  })

  async function refresh() {
    runtimeStatus.value = 'loading'
    try {
      state.value = await getJson<ConsoleState>('/api/state')
      runtimeStatus.value = 'ready'
    } catch (error) {
      runtimeStatus.value = 'error'
      reportError(error)
    }
  }

  async function updateCapturePolicy(enabled: boolean) {
    try {
      const policy = await patchJson<CapturePolicy>('/api/capture-policy', { enabled })
      if (state.value) state.value = { ...state.value, capturePolicy: policy }
      notify(
        enabled
          ? t('console.captureNotices.enabled')
          : t('console.captureNotices.disabled'),
      )
    } catch (error) {
      reportError(error)
    }
  }

  async function updateAgentAccessPolicy(enabled: boolean) {
    try {
      const policy = await patchJson<AgentAccessPolicy>(
        '/api/agent-access-policy',
        { enabled },
      )
      if (state.value) state.value = { ...state.value, agentAccessPolicy: policy }
      notify(
        enabled
          ? t('console.agentAccess.enabledNotice')
          : t('console.agentAccess.disabledNotice'),
      )
    } catch (error) {
      reportError(error)
    }
  }

  function hasCapability(name: CapabilityName) {
    return state.value?.capabilities?.[name] === true
  }

  function notify(message: string) {
    feedback.value = { message, tone: 'success' }
  }

  function reportError(error: unknown) {
    feedback.value = {
      message: error instanceof Error ? error.message : t('common.errors.operationFailed'),
      tone: 'error',
    }
  }

  function clearFeedback() {
    feedback.value = null
  }

  return {
    state,
    runtimeStatus,
    feedback,
    activePersonalSpace,
    publicRuntimeStatus,
    refresh,
    updateCapturePolicy,
    updateAgentAccessPolicy,
    hasCapability,
    notify,
    reportError,
    clearFeedback,
  }
})
