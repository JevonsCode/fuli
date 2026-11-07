import { t } from '@/i18n'
import type { useConsoleStore } from '@/stores/console'
import { clipboardText, flaMention } from './fla-mention'

/** Puts `#FLA <name>` on the clipboard and says so: the FLAs list's and every portrait menu's 复制 #FLA. */
export async function copyFlaMention(name: string, store: Pick<ReturnType<typeof useConsoleStore>, 'notify' | 'reportError'>) {
  const mention = flaMention(name)
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (!clipboard?.writeText) throw new Error('clipboard unavailable')
    await clipboard.writeText(clipboardText(mention))
    store.notify(t('flas.menu.copied', { mention }))
  } catch {
    store.reportError(new Error(t('flas.menu.copyFailed')))
  }
}
