import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { getJson } from '@/api/client'
import type { ConsoleUpdateKind } from './model'

// The console's version check (src/system/package-version-checker.js): the
// newest release on the person's update channel, judged against this version.
export type UpdateChannel = 'stable' | 'beta'

export interface PackageVersionStatus {
  status: 'ready' | 'unavailable'
  channel?: UpdateChannel
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  packageUrl: string
  checkedAt: string
  // How the console's one-click update installs it (src/system/console-update.js).
  updateKind?: ConsoleUpdateKind
}

// fresh: ask npm again unless the server's answer is under a minute old.
export const readVersionStatus = (signal?: AbortSignal, { fresh = false } = {}) =>
  getJson<PackageVersionStatus>(fresh ? '/api/system/version?fresh=1' : '/api/system/version', { signal })

/** Whether the answer offers a newer release to install. */
export const offersUpdate = (status: PackageVersionStatus | null): status is PackageVersionStatus & { latestVersion: string } =>
  status?.status === 'ready' && status.updateAvailable && Boolean(status.latestVersion)

const RETRY_MS = 1200
const MAX_TRIES = 6

/**
 * The newest release on the channel the person picked (设置 › 版本). The
 * channel saves itself with the settings form, so the check asks again until
 * the server answers for the channel shown; an older answer is never shown.
 * Every check is fresh (11-03: the page said 已是最新 hours after a release):
 * opening the page and 「检查更新」 ask npm again, behind the server's
 * one-minute cooldown. The last answer stays on screen while a recheck runs.
 */
export function useChannelVersionStatus(channel: Ref<UpdateChannel | undefined>) {
  const status = ref<PackageVersionStatus | null>(null)
  const failed = ref(false)
  const checking = ref(false)
  let controller: AbortController | null = null
  let retry: ReturnType<typeof setTimeout> | undefined

  async function check(tries = MAX_TRIES) {
    clearTimeout(retry)
    controller?.abort()
    const mine = new AbortController()
    controller = mine
    failed.value = false
    checking.value = true
    try {
      const answer = await readVersionStatus(mine.signal, { fresh: true })
      if (answer.channel && answer.channel !== channel.value && tries > 1) {
        retry = setTimeout(() => void check(tries - 1), RETRY_MS)
        return
      }
      status.value = answer
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') failed.value = true
    } finally {
      if (controller === mine) checking.value = false
    }
  }

  watch(channel, (value) => {
    status.value = null
    if (value) void check()
  }, { immediate: true })
  onBeforeUnmount(() => { clearTimeout(retry); controller?.abort() })
  return { status, failed, checking, recheck: () => check() }
}
