import { onScopeDispose, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import { t } from '@/i18n'
import { createDebouncedAction } from '@/lib/debounce'

// Typing waits for a pause; a switch or a choice saves at once.
export const TEXT_SAVE_DELAY_MS = 600
// How long 已自动保存 stays before the capsule fades.
export const SAVED_NOTICE_MS = 3000

export type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error'
export type SettingsChange = 'text' | 'choice'

// Saves the settings the person changes, one request at a time. A change made
// while a save is on its way is sent right after it, so the last edit always
// wins. A failed save keeps the person's input: nothing here writes the form.
export function useSettingsAutoSave<T>({ read, save, ready, textDelayMs = TEXT_SAVE_DELAY_MS, savedNoticeMs = SAVED_NOTICE_MS }: {
  // What would be saved now.
  read: () => T
  save: (value: T) => Promise<void>
  // False while the change cannot be sent; the fields themselves say why.
  ready: () => boolean
  textDelayMs?: number
  savedNoticeMs?: number
}) {
  const state = ref<AutoSaveState>('idle')
  const failure = ref('')
  let saved = ''
  let inFlight = false
  let changedInFlight = false
  let fade: ReturnType<typeof setTimeout> | undefined
  const pending = createDebouncedAction(() => void run(), textDelayMs)

  async function run() {
    if (inFlight) { changedInFlight = true; return }
    const value = read()
    const snapshot = JSON.stringify(value)
    if (snapshot === saved) {
      // The person put back what was saved: nothing failed any more.
      if (state.value === 'error') state.value = 'idle'
      return
    }
    if (!ready()) return
    inFlight = true
    clearTimeout(fade)
    state.value = 'saving'
    try {
      await save(value)
      saved = snapshot
      failure.value = ''
      state.value = 'saved'
      fade = setTimeout(() => { if (state.value === 'saved') state.value = 'idle' }, savedNoticeMs)
    } catch (error) {
      failure.value = apiErrorReason(error, t('settings.saveError'))
      state.value = 'error'
    } finally {
      inFlight = false
      if (changedInFlight) {
        changedInFlight = false
        void run()
      }
    }
  }

  // A pending edit is sent when the page goes away, never dropped.
  onScopeDispose(() => {
    pending.flush()
    clearTimeout(fade)
  })

  return {
    state,
    failure,
    // What the server holds now (a load or an applied restart), so it is not sent again.
    remember(value: T) { saved = JSON.stringify(value) },
    changed(kind: SettingsChange) {
      pending.schedule()
      if (kind === 'choice') pending.flush()
    },
    retry() {
      pending.cancel()
      void run()
    },
  }
}
