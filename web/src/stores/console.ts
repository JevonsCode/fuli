import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import { getJson, patchJson } from '@/api/client'
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
          ? '自动沉淀已开启；Agent 会继续把新的稳定会话知识写入本机。'
          : '自动沉淀已关闭；已有知识仍可读取，但不会写入新的会话内容。',
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
          ? 'Agent 使用已开启；已连接的 Agent 可以调用 FULI。'
          : 'Agent 使用已关闭；管理界面仍可使用，但所有 Agent 调用都会被拦截。',
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
      message: error instanceof Error ? error.message : '操作失败',
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
