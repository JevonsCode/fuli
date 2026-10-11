import { getJson } from '@/api/client'
import { t } from '@/i18n'
import type { SettingsApplyStatus, SystemSettingsResult } from '@/types'

export async function waitForSettingsApply(apply: SettingsApplyStatus, signal: AbortSignal, {
  origin = window.location.origin,
  read = () => getJson<SystemSettingsResult>('/api/system/settings', { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }),
  probe = imageReady,
  wait = () => new Promise(resolve => window.setTimeout(resolve, 1000)),
  timeout = 180000,
} = {}): Promise<{ settings?: SystemSettingsResult; url?: string }> {
  const target = new URL('/settings', origin)
  target.port = String(apply.port)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const result = await read().catch(() => null)
    signal.throwIfAborted()
    if (result?.apply?.id === apply.id) {
      if (result.apply.status === 'failed') {
        throw new Error(`${t(result.apply.rolledBack ? 'settings.applyRestored' : 'settings.applyFailed')} ${result.apply.error ?? ''}`.trim())
      }
      if (result.apply.status === 'applied' && !result.restartRequired) return { settings: result }
    }
    if (target.origin !== origin && await probe(`${target.origin}/api/system/settings/ready.svg?id=${encodeURIComponent(apply.id)}&t=${Date.now()}`, signal)) {
      target.searchParams.set('settingsApplied', apply.id)
      return { url: target.href }
    }
    await wait()
  }
  throw new Error(t('settings.applyTimeout'))
}

function imageReady(url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const image = new Image()
    const done = (ready: boolean) => {
      window.clearTimeout(timer)
      image.onload = image.onerror = null
      signal.removeEventListener('abort', abort)
      image.removeAttribute('src')
      resolve(ready)
    }
    const abort = () => done(false)
    const timer = window.setTimeout(() => done(false), 3000)
    image.onload = () => done(true)
    image.onerror = abort
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { done(false); return }
    image.src = url
  })
}
