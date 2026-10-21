import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import { getJson, patchJson } from '@/api/client'
import { t } from '@/i18n'
import type {
  AgentAccessPolicy,
  CapabilityName,
  CapturePolicy,
  CapturePolicyChange,
  ConsoleState,
  PersonalProject,
  RecallPolicy,
} from '@/types'

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'error'
export type FeedbackTone = 'success' | 'error'

export const useConsoleStore = defineStore('console', () => {
  const state = shallowRef<ConsoleState | null>(null)
  const runtimeStatus = ref<RuntimeStatus>('idle')
  const refreshError = ref('')
  let refreshVersion = 0
  let refreshController: AbortController | undefined
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
    const current = ++refreshVersion
    refreshController?.abort()
    const controller = new AbortController()
    refreshController = controller
    runtimeStatus.value = 'loading'
    refreshError.value = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Object.assign(new Error(t('common.errors.operationFailed')), { code: 'scope_timeout' }))
        }, 30000)
      })
      const result = await Promise.race([getJson<ConsoleState>('/api/state', { signal: controller.signal }), timeout])
      if (current !== refreshVersion) return
      state.value = result
      runtimeStatus.value = 'ready'
      return
    } catch (cause) {
      if (current !== refreshVersion) return
      const error = cause as { status?: number; code?: string }
      const denied = error?.status === 401 || error?.status === 403
      if (denied) state.value = null
      refreshError.value = denied ? 'denied' : error?.code === 'scope_timeout' ? 'timeout' : 'failed'
      runtimeStatus.value = 'error'
      reportError(denied ? new Error(t('common.errors.requestFailed', { status: error.status! })) : cause)
      return
    } finally {
      clearTimeout(timer)
      if (current === refreshVersion) refreshController = undefined
    }
  }

  // Every page that shows capture settings reads this one copy, so a change
  // saved anywhere in the console shows everywhere at once (rec#5 C4-1).
  function rememberCapturePolicy(policy: CapturePolicy) {
    if (state.value) state.value = { ...state.value, capturePolicy: policy }
  }

  // The settings as saved now: an Agent may have changed them since the
  // console state loaded (rec#5 C4-4). A read that a save overtook is dropped.
  let captureSaves = 0
  async function loadCapturePolicy() {
    const saves = captureSaves
    const policy = await getJson<CapturePolicy>('/api/capture-policy')
    if (saves === captureSaves) rememberCapturePolicy(policy)
  }

  // Saves at once; the caller shows its own progress and any refusal. Only the
  // latest save's answer is kept, since answers can arrive out of order.
  async function changeCapturePolicy(change: CapturePolicyChange) {
    const save = ++captureSaves
    try {
      const policy = await patchJson<CapturePolicy>('/api/capture-policy', change)
      if (save === captureSaves) rememberCapturePolicy(policy)
      return policy
    } catch (error) {
      // A refused save changed nothing, but another change may have landed meanwhile.
      if (save === captureSaves) loadCapturePolicy().catch(() => {})
      throw error
    }
  }

  async function updateCapturePolicy(enabled: boolean, disabledSources?: string[]) {
    try {
      await changeCapturePolicy(disabledSources ? { enabled, disabledSources } : { enabled })
      notify(
        enabled
          ? t('console.captureNotices.enabled')
          : t('console.captureNotices.disabled'),
      )
    } catch (error) {
      reportError(error)
    }
  }

  async function updateRecallPolicy(answerFromConfirmed: boolean) {
    try {
      const policy = await patchJson<RecallPolicy>('/api/recall-policy', { answerFromConfirmed })
      if (state.value) state.value = { ...state.value, recallPolicy: policy }
      notify(answerFromConfirmed ? t('console.recall.directNotice') : t('console.recall.verifyNotice'))
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

  // A project created on a page shows up everywhere at once. state is a
  // shallowRef, so it is replaced rather than mutated in place.
  function rememberPersonalProject(project: PersonalProject) {
    if (!state.value || state.value.personalProjects?.some(item => item.project_id === project.project_id)) return
    state.value = { ...state.value, personalProjects: [...(state.value.personalProjects ?? []), project] }
  }

  return {
    state,
    runtimeStatus,
    refreshError,
    feedback,
    activePersonalSpace,
    publicRuntimeStatus,
    refresh,
    updateCapturePolicy,
    loadCapturePolicy,
    changeCapturePolicy,
    updateAgentAccessPolicy,
    updateRecallPolicy,
    hasCapability,
    notify,
    reportError,
    clearFeedback,
    rememberPersonalProject,
  }
})
