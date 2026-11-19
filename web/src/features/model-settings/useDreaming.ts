import { computed, reactive, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import { readDreaming, runFailure, runTotals, startDreaming, type DreamingProject, type DreamingResult, type RunTotals } from './dreaming'
import type { UseStep } from './use-steps'

// What the Dreaming card and its 「查看详情」 dialog share: the projects in two
// groups (new sessions first, the rest quiet, where a run reads every session
// again), one run at a time, what each run found, and which did not finish
// with the reason. 整理全部 runs the projects with new sessions one after
// another; 重试 runs again the ones that did not finish. A run is one request,
// so while it runs the page knows only which project, its place in the queue
// and how many sessions it was going to read; what it found comes with its
// answer (rec issue 143).
type Group = 'fresh' | 'quiet'
type Running = { id: string; name: string; fromStart: boolean; sessions: number | null; index: number; total: number }

export function useDreaming() {
  const readiness = ref<string | null>(null)
  const projects = ref<DreamingProject[]>([])
  const running = ref<Running | null>(null)
  const results = ref<Record<string, DreamingResult>>({})
  // A run whose request itself failed: the reason, by project.
  const errors = ref<Record<string, string>>({})
  // Where a run started, so its row does not jump lists when its count drops to 0.
  const placed = ref<Record<string, Group>>({})

  const ready = computed(() => projects.value.filter(project => project.readiness === 'ready'))
  const groupOf = (project: DreamingProject): Group => placed.value[project.personalProjectId] ?? ((project.newSessions ?? 0) > 0 ? 'fresh' : 'quiet')
  const fresh = computed(() => ready.value.filter(project => groupOf(project) === 'fresh'))
  const quiet = computed(() => ready.value.filter(project => groupOf(project) === 'quiet'))
  const unapproved = computed(() => projects.value.filter(project => project.readiness === 'project_not_approved'))
  // Every project waits for approval: the card's action is to approve them.
  const onlyUnapproved = computed(() => readiness.value === 'ready' && !ready.value.length && unapproved.value.length > 0)

  /** Why this project's latest run did not finish: the run just made here, else the last one recorded. */
  function failureOf(project: DreamingProject): string | null {
    const id = project.personalProjectId
    if (errors.value[id]) return errors.value[id]
    const run = results.value[id]
    if (run) return runFailure(run.status, run.modelReceipt?.reason)
    return project.lastRun ? runFailure(project.lastRun.status) : null
  }
  const failed = computed(() => ready.value.filter(project => failureOf(project) !== null))
  // What 整理全部 would run now.
  const pending = computed(() => fresh.value.filter(project => (project.newSessions ?? 0) > 0 && failureOf(project) === null))
  const finished = computed(() => Object.values(results.value).filter(entry => entry.status === 'dreamed'))
  const totals = computed(() => runTotals(finished.value))

  async function load() {
    const state = await readDreaming().catch(() => null)
    readiness.value = state?.readiness ?? 'unavailable'
    if (state) projects.value = state.projects
  }

  async function run(project: DreamingProject, fromStart = groupOf(project) === 'quiet', queue = { index: 1, total: 1 }) {
    const id = project.personalProjectId
    placed.value = { ...placed.value, [id]: groupOf(project) }
    running.value = { id, name: project.name, fromStart, sessions: fromStart ? null : project.newSessions, ...queue }
    errors.value = Object.fromEntries(Object.entries(errors.value).filter(([key]) => key !== id))
    try {
      results.value = { ...results.value, [id]: await startDreaming(id, fromStart) }
    } catch (cause) {
      errors.value = { ...errors.value, [id]: apiErrorReason(cause) }
    }
    await load()
    running.value = null
  }

  // One after another: a run sends sessions to the model, and its budget is shared.
  async function runEach(list: readonly DreamingProject[]) {
    const queue = [...list]
    for (const [index, project] of queue.entries()) await run(project, undefined, { index: index + 1, total: queue.length })
  }
  const runAll = () => runEach(pending.value)
  const retry = () => runEach(failed.value)

  const lastRunText = (project: DreamingProject) => {
    const when = project.lastRun && formatRelativeTime(project.lastRun.at, currentLocale())
    return when ? t('modelSettings.dreaming.lastRun', { when }) : t('modelSettings.dreaming.neverRun')
  }

  /** What one or more finished runs found: sessions read, leads, what reached the queue, and what did not. */
  function foundText(found: RunTotals) {
    const parts = [t('modelSettings.dreaming.found', { sessions: found.sessions, candidates: found.candidates, count: found.queued })]
    if (found.unread) parts.push(t('modelSettings.dreaming.unread', { count: found.unread }))
    if (found.missed) parts.push(t('modelSettings.dreaming.missed', { count: found.missed }))
    if (found.tokens) parts.push(t('modelSettings.dreaming.tokens', { tokens: found.tokens }))
    return parts.join(' · ')
  }

  /** The run going on now, with its place in the queue when there is more than one. */
  const runningText = computed(() => {
    const now = running.value
    if (!now) return ''
    const line = now.fromStart || now.sessions === null ? t('modelSettings.dreaming.rereadingLine', { name: now.name })
      : t('modelSettings.dreaming.runningLine', { name: now.name, count: now.sessions })
    return now.total > 1 ? `${t('modelSettings.dreaming.queue', { index: now.index, total: now.total })} · ${line}` : line
  })

  /** One project's line: why it did not finish, what its run found, or what waits. */
  function meta(project: DreamingProject) {
    const failure = failureOf(project)
    if (failure) return t('modelSettings.dreaming.notFinished', { reason: failure })
    const run = results.value[project.personalProjectId]
    if (run) return run.status === 'dreamed' ? foundText(runTotals([run])) : t('modelSettings.dreaming.nothingNew')
    if ((project.newSessions ?? 0) > 0) return t('modelSettings.dreaming.newSessions', { count: project.newSessions ?? 0, last: lastRunText(project) })
    if (!project.lastRun) return t('modelSettings.dreaming.noSessions')
    return t('modelSettings.dreaming.noNewSessions', { last: lastRunText(project) })
  }

  /** What did not finish and why, in one line; empty when every run finished. */
  const failureText = computed(() => {
    const first = failed.value[0]
    if (!first) return ''
    const reason = failureOf(first) ?? ''
    return failed.value.length === 1 ? t('modelSettings.dreaming.failedOne', { name: first.name, reason })
      : t('modelSettings.dreaming.failedMany', { count: failed.value.length, reason })
  })

  // The card's one line: the run going on, what did not finish, what the runs made here found, else what waits.
  const summary = computed(() => {
    if (running.value) return { kind: 'running' as const, text: runningText.value }
    if (failureText.value) return { kind: 'failed' as const, text: failureText.value }
    if (onlyUnapproved.value) return { kind: 'unapproved' as const, text: t('modelSettings.dreaming.notApproved', { count: unapproved.value.length }) }
    if (finished.value.length && !pending.value.length) return { kind: 'found' as const, queued: totals.value.queued, text: foundText(totals.value) }
    const latest = ready.value.flatMap(project => project.lastRun?.at ?? []).sort().at(-1)
    const when = latest && formatRelativeTime(latest, currentLocale())
    const last = when ? t('modelSettings.dreaming.lastRun', { when }) : t('modelSettings.dreaming.neverRun')
    const sessions = pending.value.reduce((sum, project) => sum + (project.newSessions ?? 0), 0)
    return { kind: 'waiting' as const, text: pending.value.length ? t('modelSettings.dreaming.freshProjects', { count: pending.value.length, sessions, last })
      : t('modelSettings.dreaming.noNewSessions', { last }) }
  })

  // How a run works, in three steps; each says what the page saw of it.
  const steps = computed<UseStep[]>(() => {
    const step = (id: string, extra: Partial<UseStep> = {}): UseStep =>
      ({ id, title: t(`modelSettings.dreaming.steps.${id}.title`), detail: t(`modelSettings.dreaming.steps.${id}.how`), ...extra })
    if (running.value) return [step('read', { state: 'active', detail: runningText.value }), step('pick'), step('review')]
    if (!finished.value.length) return [step('read'), step('pick'), step('review')]
    const found = totals.value
    const unread = found.unread ? ` · ${t('modelSettings.dreaming.unread', { count: found.unread })}` : ''
    return [
      step('read', { state: 'done', detail: t('modelSettings.dreaming.steps.read.done', { sessions: found.sessions, candidates: found.candidates }) + unread }),
      step('pick', { state: 'done', detail: t('modelSettings.dreaming.steps.pick.done', { count: found.queued + found.missed }) }),
      step('review', found.queued ? { state: 'active', detail: t('modelSettings.dreaming.steps.review.waiting', { count: found.queued }) }
        : { detail: t('modelSettings.dreaming.steps.review.none') }),
    ]
  })

  return reactive({ readiness, ready, fresh, quiet, unapproved, onlyUnapproved, failed, pending, running, results, summary, failureText, steps, totals,
    load, run, runAll, retry, failureOf, meta })
}

export type Dreaming = ReturnType<typeof useDreaming>
