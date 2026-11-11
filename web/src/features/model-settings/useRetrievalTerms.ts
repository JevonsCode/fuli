import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import { fillTerms, readTerms, stopTerms, trialTerms, type TermsState, type TermsTrial } from './retrieval-terms'

// What the 补检索词 card and its 「查看详情」 dialog share (rec#92): the chosen
// project's count of knowledge without retrieval terms (free), a self-test on
// 20 items that measures with real searches how many more are found and what
// an item costs, then the fill of the rest, which runs in the background and
// can stop. A fill the model stopped answering can be run again.
export function useRetrievalTerms(projects: () => readonly PersonalProject[], model: () => string | null) {
  const projectId = ref('')
  const state = ref<TermsState | null>(null)
  const testing = ref(false)
  const declined = ref(false)
  const error = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let unmounted = false

  const choices = computed(() => projects().filter(project => project.scope_type !== 'temporary')
    .map(project => ({ value: project.project_id, label: project.profile.name })))
  const projectName = computed(() => choices.value.find(choice => choice.value === projectId.value)?.label ?? projectId.value)
  // Without Astro's model, or with the task off in its settings, the action opens those settings.
  const needsAstro = computed(() => state.value?.readiness === 'needs_model' || state.value?.readiness === 'not_allowed')
  const ready = computed(() => state.value?.readiness === 'ready')
  const filling = computed(() => state.value?.run?.status === 'running')
  const failed = computed(() => state.value?.run?.status === 'model_failed')
  const busyElsewhere = computed(() => Boolean(state.value?.busy && state.value.busy.personalProjectId !== projectId.value))
  const trial = computed<TermsTrial | null>(() => (declined.value ? null : state.value?.trial ?? null))
  const missing = computed(() => state.value?.stats?.missing ?? 0)
  const note = computed(() => {
    const readiness = state.value?.readiness
    // Without Astro's model the model line already says so.
    if (readiness === 'needs_model') return model() ? t('modelSettings.retrievalTerms.needsModel') : ''
    if (readiness === 'not_allowed') return t('modelSettings.retrievalTerms.notAllowed')
    if (readiness === 'project_not_approved') return t('modelSettings.retrievalTerms.notApproved')
    return ''
  })
  // How the chosen project stands, in one line.
  const line = computed(() => {
    const stats = state.value?.stats
    const run = state.value?.run
    if (!stats) return ''
    if (filling.value) return t('modelSettings.retrievalTerms.filling', { written: run?.written ?? 0, total: missing.value + (run?.written ?? 0), tokens: run?.tokens ?? 0 })
    if (!missing.value) return t('modelSettings.retrievalTerms.complete', { count: stats.items })
    if (failed.value) return lastRun.value
    return t('modelSettings.retrievalTerms.missing', { count: missing.value, tokens: stats.roughTokens })
  })
  // What the last fill did, once it is over.
  const lastRun = computed(() => {
    const run = state.value?.run
    return run && run.status !== 'running' ? t(`modelSettings.retrievalTerms.run.${run.status}`, { written: run.written ?? 0, tokens: run.tokens ?? 0 }) : ''
  })

  watch(choices, (next) => { if (!projectId.value && next[0]) projectId.value = next[0].value }, { immediate: true })
  watch(projectId, () => { declined.value = false; void load() }, { immediate: true })
  onBeforeUnmount(() => { unmounted = true; clearTimeout(timer) })

  async function load() {
    clearTimeout(timer)
    if (!projectId.value) return
    error.value = ''
    try {
      state.value = await readTerms(projectId.value)
    } catch (cause) {
      error.value = apiErrorReason(cause)
    }
    if (!unmounted && filling.value) timer = setTimeout(load, 3000)
  }

  async function act(action: () => Promise<unknown>) {
    let failure = ''
    try {
      await action()
    } catch (cause) {
      failure = apiErrorReason(cause)
    }
    await load()
    if (failure) error.value = failure
  }

  async function test() {
    testing.value = true
    declined.value = false
    await act(() => trialTerms(projectId.value))
    testing.value = false
  }

  const fill = () => act(() => fillTerms(projectId.value))
  const stop = () => act(stopTerms)
  const decline = () => { declined.value = true }
  const choose = (id: string) => { projectId.value = id }

  return reactive({ projectId, state, testing, error, choices, projectName, needsAstro, ready, filling, failed, busyElsewhere, trial, missing, note, line, lastRun,
    load, test, fill, stop, decline, choose })
}

export type RetrievalTerms = ReturnType<typeof useRetrievalTerms>
