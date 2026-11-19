import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import { fillTerms, readTerms, stopTerms, trialStopped, trialTerms, type TermsState, type TermsTrial } from './retrieval-terms'
import type { UseStep } from './use-steps'

// What the 补检索词 card and its 「查看详情」 dialog share (rec#92): the chosen
// project's count of knowledge without retrieval terms (free), a self-test on
// 20 items that measures with real searches how many more are found and what
// an item costs, then the fill of the rest, which runs in the background and
// can stop. A fill the model stopped answering can be run again. The card
// and the details' steps show only what the server answered: the counts, the
// self-test's measure or why it stopped, and the fill's written of total (rec issue 143).
export function useRetrievalTerms(projects: () => readonly PersonalProject[], model: () => string | null) {
  const projectId = ref('')
  const state = ref<TermsState | null>(null)
  // The project a self-test runs for; the chosen project shows it only when it is that one.
  const testingFor = ref('')
  const testing = computed(() => Boolean(testingFor.value) && testingFor.value === projectId.value)
  // Every read gets a number; an answer for an older read or another project is dropped.
  let reads = 0
  const declined = ref(false)
  const error = ref('')
  // Why the last self-test stopped before it measured anything, and whether the model is why.
  const trialFailure = ref<{ text: string; model: boolean } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let unmounted = false

  const choices = computed(() => projects().filter(project => project.scope_type !== 'temporary')
    .map(project => ({ value: project.project_id, label: project.profile.name })))
  const projectName = computed(() => choices.value.find(choice => choice.value === projectId.value)?.label ?? projectId.value)
  // Without Astro's model, or with the task off in its settings, the action opens those settings.
  const needsAstro = computed(() => state.value?.readiness === 'needs_model' || state.value?.readiness === 'not_allowed')
  // The project is not approved for Astro's model: the action approves it in Astro's settings.
  const needsApproval = computed(() => state.value?.readiness === 'project_not_approved')
  const ready = computed(() => state.value?.readiness === 'ready')
  const filling = computed(() => state.value?.run?.status === 'running')
  const failed = computed(() => state.value?.run?.status === 'model_failed')
  const busyElsewhere = computed(() => Boolean(state.value?.busy && state.value.busy.personalProjectId !== projectId.value))
  const trial = computed<TermsTrial | null>(() => (declined.value ? null : state.value?.trial ?? null))
  const missing = computed(() => state.value?.stats?.missing ?? 0)
  // A measured self-test that waits for the person's choice: fill the rest or not.
  const tested = computed(() => trial.value?.status === 'tested' && missing.value > 0 && !filling.value && !failed.value)
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
  // What the self-test measured, with its advice.
  const trialResult = computed(() => (trial.value?.status === 'tested'
    ? t('modelSettings.retrievalTerms.tested', { sample: trial.value.sample ?? 0, before: trial.value.before ?? 0, after: trial.value.after ?? 0,
      advice: t(`modelSettings.retrievalTerms.advice.${trial.value.advice ?? 'not_worth'}`) }) : ''))
  // The card's line: the self-test's measure while it waits for a choice, else how the project stands with the next step.
  const summary = computed(() => {
    if (!line.value) return ''
    const text = tested.value ? trialResult.value
      : missing.value && !filling.value && !failed.value && !trial.value ? `${line.value}${t('modelSettings.retrievalTerms.nextTrial')}` : line.value
    return `${projectName.value} · ${text}`
  })

  // How filling works, in three steps; each says what the server answered of it.
  const steps = computed<UseStep[]>(() => {
    const step = (id: string, extra: Partial<UseStep> = {}): UseStep =>
      ({ id, title: t(`modelSettings.retrievalTerms.steps.${id}.title`), detail: t(`modelSettings.retrievalTerms.steps.${id}.how`), ...extra })
    const stats = state.value?.stats
    const run = state.value?.run
    // Nothing counted yet (a project not approved, or one still being read): every step is still to come.
    if (!stats) return [step('count'), step('trial'), step('fill')]
    const count = step('count', stats ? { state: 'done', detail: missing.value ? t('modelSettings.retrievalTerms.missing', { count: missing.value, tokens: stats.roughTokens })
      : t('modelSettings.retrievalTerms.complete', { count: stats.items }) } : {})
    const sample = testing.value ? step('trial', { state: 'active', detail: t('modelSettings.retrievalTerms.testing', { name: projectName.value }) })
      : trialFailure.value ? step('trial', { state: 'failed', detail: t('modelSettings.retrievalTerms.trialStopped', { reason: trialFailure.value.text }) })
        : trial.value?.status === 'tested' ? step('trial', { state: 'done', detail: trialResult.value }) : step('trial')
    const written = run?.written ?? 0
    const fillStep = filling.value ? step('fill', { state: 'active', detail: line.value, progress: { done: written, total: missing.value + written } })
      : run?.status === 'done' ? step('fill', { state: 'done', detail: lastRun.value })
        : run ? step('fill', { ...(failed.value ? { state: 'failed' as const } : {}), detail: lastRun.value }) : step('fill')
    return [count, sample, fillStep]
  })

  watch(choices, (next) => { if (!projectId.value && next[0]) projectId.value = next[0].value }, { immediate: true })
  // Another project: nothing of the last one stays on screen while its own state is read.
  watch(projectId, () => {
    declined.value = false
    trialFailure.value = null
    state.value = null
    error.value = ''
    void load()
  }, { immediate: true })
  onBeforeUnmount(() => { unmounted = true; clearTimeout(timer) })

  async function load() {
    clearTimeout(timer)
    const id = projectId.value
    if (!id) return
    const read = ++reads
    let next: TermsState | null = null
    let failure = ''
    try {
      next = await readTerms(id)
    } catch (cause) {
      failure = apiErrorReason(cause)
    }
    if (read !== reads || id !== projectId.value) return
    error.value = failure
    if (next) state.value = next
    if (!unmounted && filling.value) timer = setTimeout(load, 3000)
  }

  // An action for the project chosen when it started; once another is chosen, its answer is not shown there.
  async function act(action: (id: string) => Promise<unknown>) {
    const id = projectId.value
    let failure = ''
    try {
      await action(id)
    } catch (cause) {
      failure = apiErrorReason(cause)
    }
    if (id !== projectId.value) return
    await load()
    if (failure && id === projectId.value) error.value = failure
  }

  async function test() {
    const id = projectId.value
    testingFor.value = id
    declined.value = false
    trialFailure.value = null
    await act(async () => {
      const stopped = trialStopped(await trialTerms(id))
      if (id === projectId.value) trialFailure.value = stopped
    })
    if (testingFor.value === id) testingFor.value = ''
  }

  const fill = () => act(id => fillTerms(id))
  const stop = () => act(stopTerms)
  const decline = () => { declined.value = true }
  const choose = (id: string) => { projectId.value = id }

  return reactive({ projectId, state, testing, error, trialFailure, choices, projectName, needsAstro, needsApproval, ready, filling, failed, busyElsewhere, trial,
    tested, missing, note, line, lastRun, summary, steps, load, test, fill, stop, decline, choose })
}

export type RetrievalTerms = ReturnType<typeof useRetrievalTerms>
