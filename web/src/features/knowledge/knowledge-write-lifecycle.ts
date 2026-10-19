import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { t } from '@/i18n'

// Identity metadata only. No content, evidence or input values are cached here.
const writes = reactive(new Map<string, 'pending' | 'unconfirmed'>())
export function reconcileKnowledgeWrites(spaceId: string, items?: ReadonlyArray<{ itemKind: string; id: string }>) {
  const returned = items ? new Set(items.map(item => `${spaceId}:${item.itemKind}:${item.id}`)) : null
  for (const [key, state] of writes) if (key.startsWith(`${spaceId}:`) && (!returned || returned.has(key)) && state === 'unconfirmed') writes.delete(key)
}
export function useKnowledgeWriteLifecycle(identity: () => string, accessDenied: () => void, context: () => unknown = identity) {
  const busy = ref(false)
  const takingLong = ref(false)
  const error = ref('')
  const locked = computed(() => writes.has(identity()))
  let generation = 0
  let controller: AbortController | null = null
  let slow: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let activeKey = ''
  function clearTimers() { clearTimeout(slow); clearTimeout(deadline) }
  function invalidate() {
    ++generation
    if (busy.value && activeKey) writes.set(activeKey, 'unconfirmed')
    controller?.abort()
    clearTimers()
    busy.value = false
    takingLong.value = false
    error.value = writes.get(identity()) === 'unconfirmed' ? t('preferences.detail.unconfirmed') : ''
  }
  watch(() => [identity(), context()], invalidate, { immediate: true, flush: 'sync' })
  onBeforeUnmount(invalidate)
  async function run(operation: (signal: AbortSignal) => Promise<unknown>, success: () => void) {
    const key = identity()
    if (!key || busy.value || writes.has(key)) return
    activeKey = key
    const version = ++generation
    const request = new AbortController()
    controller = request
    writes.set(key, 'pending')
    busy.value = true
    error.value = ''
    const current = () => version === generation && key === identity()
    slow = setTimeout(() => { if (current()) takingLong.value = true }, 8000)
    const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject({ unconfirmed: true }), 30000) })
    try {
      await Promise.race([operation(request.signal), timeout])
      if (!current()) return
      writes.delete(key)
      success()
    } catch (cause) {
      if (!current()) return
      const status = Number((cause as { status?: number })?.status)
      if (status === 401 || status === 403) { writes.delete(key); error.value = t('preferences.detail.accessDenied'); accessDenied(); return }
      if (status === 409) {
        writes.set(key, 'unconfirmed')
        error.value = t('preferences.detail.readConflict')
      } else if (!status || status >= 500 || (cause as { unconfirmed?: boolean })?.unconfirmed) {
        writes.set(key, 'unconfirmed')
        error.value = t('preferences.detail.unconfirmed')
        request.abort()
      } else {
        writes.delete(key)
        error.value = t('preferences.detail.writeFailed', { status })
      }
    } finally {
      if (current()) { clearTimers(); busy.value = false; takingLong.value = false; controller = null }
    }
  }
  return { busy, takingLong, locked, error, run }
}
