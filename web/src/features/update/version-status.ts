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

export const readVersionStatus = (signal?: AbortSignal) =>
  getJson<PackageVersionStatus>('/api/system/version', { signal })

/** Whether the answer offers a newer release to install. */
export const offersUpdate = (status: PackageVersionStatus | null): status is PackageVersionStatus & { latestVersion: string } =>
  status?.status === 'ready' && status.updateAvailable && Boolean(status.latestVersion)

const RETRY_MS = 1200
const MAX_TRIES = 6

/**
 * The newest release on the channel the person picked (设置 › 版本). The
 * channel saves itself with the settings form, so the check asks again until
 * the server answers for the channel shown; an older answer is never shown.
 */
export function useChannelVersionStatus(channel: Ref<UpdateChannel | undefined>) {
  const status = ref<PackageVersionStatus | null>(null)
  const failed = ref(false)
  let controller: AbortController | null = null
  let retry: ReturnType<typeof setTimeout> | undefined

  async function check(tries = MAX_TRIES) {
    clearTimeout(retry)
    controller?.abort()
    controller = new AbortController()
    failed.value = false
    try {
      const answer = await readVersionStatus(controller.signal)
      if (answer.channel && answer.channel !== channel.value && tries > 1) {
        retry = setTimeout(() => void check(tries - 1), RETRY_MS)
        return
      }
      status.value = answer
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') failed.value = true
    }
  }

  watch(channel, (value) => {
    status.value = null
    if (value) void check()
  }, { immediate: true })
  onBeforeUnmount(() => { clearTimeout(retry); controller?.abort() })
  return { status, failed }
}
