import { computed, reactive, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import { queuedCount, readDreaming, runFailure, startDreaming, type DreamingProject, type DreamingResult } from './dreaming'

// What the Dreaming card and its 「查看详情」 dialog share: the projects in two
// groups (new sessions first, the rest quiet, where a run reads every session
// again), one run at a time, what each run found, and which did not finish
// with the reason. 整理全部 runs the projects with new sessions one after
// another; 重试 runs again the ones that did not finish.
type Group = 'fresh' | 'quiet'

export function useDreaming() {
  const readiness = ref<string | null>(null)
  const projects = ref<DreamingProject[]>([])
  const running = ref<{ id: string; name: string; fromStart: boolean } | null>(null)
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

  async function load() {
    const state = await readDreaming().catch(() => null)
    readiness.value = state?.readiness ?? 'unavailable'
    if (state) projects.value = state.projects
  }

  async function run(project: DreamingProject, fromStart = groupOf(project) === 'quiet') {
    const id = project.personalProjectId
    placed.value = { ...placed.value, [id]: groupOf(project) }
    running.value = { id, name: project.name, fromStart }
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
    for (const project of list) await run(project)
  }
  const runAll = () => runEach(pending.value)
  const retry = () => runEach(failed.value)

  const lastRunText = (project: DreamingProject) => {
    const when = project.lastRun && formatRelativeTime(project.lastRun.at, currentLocale())
    return when ? t('modelSettings.dreaming.lastRun', { when }) : t('modelSettings.dreaming.neverRun')
  }

  /** One project's line: why it did not finish, what its run found, or what waits. */
  function meta(project: DreamingProject) {
    const failure = failureOf(project)
    if (failure) return t('modelSettings.dreaming.notFinished', { reason: failure })
    const run = results.value[project.personalProjectId]
    if (run) return run.status === 'dreamed' ? t('modelSettings.dreaming.found', { sessions: run.sessions ?? 0, count: queuedCount(run) }) : t('modelSettings.dreaming.nothingNew')
    if ((project.newSessions ?? 0) > 0) return t('modelSettings.dreaming.newSessions', { count: project.newSessions ?? 0, last: lastRunText(project) })
    if (!project.lastRun) return t('modelSettings.dreaming.noSessions')
    return t('modelSettings.dreaming.noNewSessions', { last: lastRunText(project) })
  }

  // The card's one line: what did not finish, else what the runs made here found, else what waits.
  const summary = computed(() => {
    const first = failed.value[0]
    if (first) {
      const reason = failureOf(first) ?? ''
      return { kind: 'failed' as const, text: failed.value.length === 1 ? t('modelSettings.dreaming.failedOne', { name: first.name, reason })
        : t('modelSettings.dreaming.failedMany', { count: failed.value.length, reason }) }
    }
    const runs = Object.values(results.value).filter(entry => entry.status === 'dreamed')
    if (runs.length && !pending.value.length) {
      const queued = runs.reduce((sum, entry) => sum + queuedCount(entry), 0)
      return { kind: 'found' as const, queued, text: t('modelSettings.dreaming.found', { sessions: runs.reduce((sum, entry) => sum + (entry.sessions ?? 0), 0), count: queued }) }
    }
    const latest = ready.value.flatMap(project => project.lastRun?.at ?? []).sort().at(-1)
    const when = latest && formatRelativeTime(latest, currentLocale())
    const last = when ? t('modelSettings.dreaming.lastRun', { when }) : t('modelSettings.dreaming.neverRun')
    return { kind: 'waiting' as const, text: pending.value.length ? t('modelSettings.dreaming.freshProjects', { count: pending.value.length, last })
      : t('modelSettings.dreaming.noNewSessions', { last }) }
  })

  return reactive({ readiness, ready, fresh, quiet, unapproved, failed, pending, running, results, summary, load, run, runAll, retry, failureOf, meta })
}

export type Dreaming = ReturnType<typeof useDreaming>
