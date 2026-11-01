import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { z } from 'zod'
import { shapeFor } from '@/api/response-shape'

import { getJson, patchJson, postJson } from '@/api/client'
import { t } from '@/i18n'
import type {
  AgentAccessPolicy,
  CapabilityName,
  CapturePolicy,
  CapturePolicyChange,
  CaptureOnboardingState,
  CaptureScopeAnswer,
  CaptureScopeOutcome,
  ConsoleState,
  PersonalProject,
  RecallPolicy,
} from '@/types'

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'error'
export type FeedbackTone = 'success' | 'error'

// The console state as the API answers it: the spaces and projects every page
// reads first. Policies and provider status pass through as ConsoleState.
const consoleStateShape = shapeFor<ConsoleState>(z.looseObject({
  mode: z.string(),
  activePersonalSpaceId: z.string().nullish(),
  personalSpaces: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  personalProjects: z.array(z.looseObject({
    project_id: z.string(),
    personal_space_id: z.string(),
    profile: z.looseObject({ name: z.string() }),
  })).optional(),
  projects: z.array(z.looseObject({})),
  subscriptions: z.array(z.looseObject({})),
}))

// The capture settings as the server answers them: only `enabled` is always
// there; the lists and project switches come with the settings version in
// use, so the console treats each as optional.
const capturePolicyFields = {
  enabled: z.boolean(),
  disabledSources: z.array(z.string()).optional(),
  capturedSources: z.array(z.string()).optional(),
  projectMode: z.string().optional(),
  excludedProjectIds: z.array(z.string()).optional(),
  selectedProjectIds: z.array(z.string()).optional(),
  unregisteredDirectories: z.string().optional(),
  updatedAt: z.string().nullish(),
}
const capturePolicyShape = shapeFor<CapturePolicy>(z.looseObject(capturePolicyFields))
const captureScopeOutcomeShape = shapeFor<CaptureScopeOutcome>(z.discriminatedUnion('status', [
  z.looseObject({ status: z.literal('answered'), choice: z.string(), capturePolicy: z.looseObject(capturePolicyFields) }),
  z.looseObject({ status: z.literal('gone') }),
]))
const captureOnboardingShape = shapeFor<CaptureOnboardingState>(z.looseObject({
  ask: z.boolean(),
  capturePolicy: z.looseObject(capturePolicyFields),
}))
const recallPolicyShape = shapeFor<RecallPolicy>(z.looseObject({
  answerFromConfirmed: z.boolean(),
  updatedAt: z.string().nullish(),
}))
const agentAccessPolicyShape = shapeFor<AgentAccessPolicy>(z.looseObject({
  enabled: z.boolean(),
  updatedAt: z.string().nullish(),
}))

export const useConsoleStore = defineStore('console', () => {
  const state = shallowRef<ConsoleState | null>(null)
  const runtimeStatus = ref<RuntimeStatus>('idle')
  const refreshError = ref('')
  // The last failed read's own message, for a page that shows it and the prompt the person copies.
  const refreshMessage = ref('')
  let refreshVersion = 0
  let refreshController: AbortController | undefined
  // link: where the change can be seen and changed again (a route).
  const feedback = ref<{ message: string; tone: FeedbackTone; link?: { to: string; label?: string } } | null>(null)

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
    refreshMessage.value = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Object.assign(new Error(t('common.errors.operationFailed')), { code: 'scope_timeout' }))
        }, 30000)
      })
      const result = await Promise.race([getJson('/api/state', consoleStateShape, { signal: controller.signal }), timeout])
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
      refreshMessage.value = cause instanceof Error ? cause.message : ''
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
  // console state loaded (rec#5 C4-4). A read that overlaps a save in any way
  // (started during one, or a save started after it) is dropped: the save's
  // own answer is the settings after it, and a refused save reads again.
  let captureSaves = 0
  let capturesInFlight = 0
  async function loadCapturePolicy() {
    const saves = captureSaves
    const overlapped = capturesInFlight > 0
    const policy = await getJson('/api/capture-policy', capturePolicyShape)
    if (!overlapped && saves === captureSaves) rememberCapturePolicy(policy)
  }

  // The settings as saved once every save this console sent has answered: the
  // policy this read returned and the store now holds. A read that a save
  // overlapped is taken again, so the answer is never an older cache
  // (dot review, PR 262). Pages that show "what is saved now" use this;
  // loadCapturePolicy only refreshes and proves nothing.
  async function settledCapturePolicy(): Promise<CapturePolicy> {
    for (;;) {
      const saves = captureSaves
      await captureWrites
      const policy = await getJson('/api/capture-policy', capturePolicyShape)
      if (saves === captureSaves && capturesInFlight === 0) {
        rememberCapturePolicy(policy)
        return policy
      }
    }
  }

  // Saves at once; the caller shows its own progress and any refusal. Saves
  // from every page of this console go out one after another, so the server
  // commits them in the order they were made and the last answer is the
  // settings after all of them (dot review P2, PR 262): with overlapping
  // requests a later one could commit first and the earlier answer, though
  // newer on the server, would look stale here.
  let captureWrites: Promise<unknown> = Promise.resolve()
  function changeCapturePolicy(change: CapturePolicyChange) {
    return queueCaptureSave(() => patchJson('/api/capture-policy', change, capturePolicyShape), policy => policy)
  }

  // The person's answer to a new installation's question, where FULI records
  // (rec#5 C10). It saves the capture settings, so it queues with every other
  // capture save. Either way the question is closed here: answered now, or
  // already answered elsewhere and the settings are read again.
  async function answerCaptureScope(answer: CaptureScopeAnswer) {
    const outcome = await queueCaptureSave(() => postJson('/api/capture-onboarding', answer, captureScopeOutcomeShape),
      sent => sent.status === 'answered' ? sent.capturePolicy : null)
    if (state.value) state.value = { ...state.value, captureOnboarding: { ask: false } }
    if (outcome.status === 'gone') void refreshAfterRefusal()
    return outcome
  }

  // The question and the settings as the server holds them once every save
  // this console sent has answered: what an answer whose response was lost
  // actually did (dot review P2-3, PR 266).
  async function readCaptureOnboarding() {
    await captureWrites
    const read = await getJson('/api/capture-onboarding', captureOnboardingShape)
    if (state.value) state.value = { ...state.value, capturePolicy: read.capturePolicy, captureOnboarding: { ask: read.ask } }
    return read
  }

  async function queueCaptureSave<T>(send: () => Promise<T>, savedPolicy: (answer: T) => CapturePolicy | null) {
    ++captureSaves
    capturesInFlight += 1
    const write = captureWrites.then(send)
    captureWrites = write.catch(() => {})
    try {
      const answer = await write
      const policy = savedPolicy(answer)
      if (policy) rememberCapturePolicy(policy)
      return answer
    } catch (error) {
      // A refused save changed nothing, a lost answer may have saved: read the
      // settings again once no later save will answer for them.
      void refreshAfterRefusal()
      throw error
    } finally {
      capturesInFlight -= 1
    }
  }

  async function refreshAfterRefusal() {
    await Promise.resolve()
    await loadCapturePolicy().catch(() => {})
  }

  async function updateCapturePolicy(enabled: boolean, sources?: Pick<CapturePolicyChange, 'disabledSources' | 'capturedSources'>) {
    try {
      await changeCapturePolicy({ enabled, ...sources })
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
      const policy = await patchJson('/api/recall-policy', { answerFromConfirmed }, recallPolicyShape)
      if (state.value) state.value = { ...state.value, recallPolicy: policy }
      notify(answerFromConfirmed ? t('console.recall.directNotice') : t('console.recall.verifyNotice'))
    } catch (error) {
      reportError(error)
    }
  }

  async function updateAgentAccessPolicy(enabled: boolean) {
    try {
      const policy = await patchJson('/api/agent-access-policy', { enabled }, agentAccessPolicyShape)
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

  function notify(message: string, link?: { to: string; label?: string }) {
    feedback.value = { message, tone: 'success', ...(link ? { link } : {}) }
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
    refreshMessage,
    refreshError,
    feedback,
    activePersonalSpace,
    publicRuntimeStatus,
    refresh,
    updateCapturePolicy,
    loadCapturePolicy,
    settledCapturePolicy,
    changeCapturePolicy,
    answerCaptureScope,
    readCaptureOnboarding,
    rememberCapturePolicy,
    updateAgentAccessPolicy,
    updateRecallPolicy,
    hasCapability,
    notify,
    reportError,
    clearFeedback,
    rememberPersonalProject,
  }
})
