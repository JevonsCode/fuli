import { onBeforeUnmount, ref } from 'vue'

import { ApiError } from '@/api/client'
import {
  graphBackupFinished, readGraphBackup, refusalCode, refusalMessage, type GraphBackupJob,
} from './model'

// Follows one graph backup or restore (src/data-format/console-graph-backup.js)
// until it reports an outcome. FULI is stopped meanwhile, so a failed read is
// expected; the page gives up asking after a while and says FULI is not back.
const POLL_MS = 3000
const GIVE_UP_MS = 30 * 60_000

export function useGraphBackupJob(version: () => number, onFinished: (job: GraphBackupJob) => void = () => {}) {
  const running = ref<GraphBackupJob | null>(null)
  const outcome = ref<GraphBackupJob | null>(null)
  const notBack = ref(false)
  // Another tab had started the same backup: this page follows that one.
  const joined = ref(false)
  // Why it did not start: the server's code (worded by the page) and its own text.
  const refusal = ref<{ code: string | null; hostOnly: boolean; message: string } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let unmounted = false
  let last: GraphBackupJob | null = null

  async function start(begin: () => Promise<GraphBackupJob>) {
    refusal.value = null
    outcome.value = null
    notBack.value = false
    joined.value = false
    let started: GraphBackupJob
    try {
      started = await begin()
    } catch (cause) {
      refusal.value = { code: refusalCode(cause), hostOnly: cause instanceof ApiError && cause.status === 403,
        message: refusalMessage(cause) }
      return
    }
    joined.value = started.joined === true
    follow(started)
  }

  function follow(job: GraphBackupJob) {
    last = job
    notBack.value = false
    running.value = job
    const deadline = Date.now() + GIVE_UP_MS
    const ask = async () => {
      if (unmounted) return
      let latest: GraphBackupJob | null = null
      try { latest = (await readGraphBackup(version())).job } catch { /* FULI is paused */ }
      if (unmounted) return
      if (latest?.id === job.id) running.value = latest
      if (graphBackupFinished(latest, job.id)) {
        running.value = null
        outcome.value = latest
        onFinished(latest)
        return
      }
      if (Date.now() >= deadline) {
        running.value = null
        notBack.value = true
        return
      }
      timer = setTimeout(ask, POLL_MS)
    }
    if (graphBackupFinished(job, job.id)) void ask()
    else timer = setTimeout(ask, POLL_MS)
  }

  onBeforeUnmount(() => {
    unmounted = true
    clearTimeout(timer)
  })

  // After it gave up: ask again for the job it followed last.
  const resume = () => { if (last) follow(last) }

  return { running, outcome, notBack, joined, refusal, start, follow, resume }
}
