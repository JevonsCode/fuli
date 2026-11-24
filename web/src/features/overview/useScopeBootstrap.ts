import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// How long the first console read may take before the page says it is slow, and
// when it stops waiting for it.
const SLOW_MS = 8000
const GIVE_UP_MS = 30000

/**
 * The first console read a home page waits for (工作台 and 今天). Bootstrap is
 * owned by the shared console store; this bounds the visible wait, does not
 * accept a late initial result after the page's 30-second budget, and says
 * in words why the scope could not be read. `onReady` re-reads the page's own
 * data after a successful retry.
 */
export function useScopeBootstrap(denied: Ref<boolean>, onReady: () => void) {
  const store = useConsoleStore()
  const timedOut = ref(false), slow = ref(false), retrying = ref(false)
  let slowTimer: ReturnType<typeof setTimeout> | undefined, endTimer: ReturnType<typeof setTimeout> | undefined
  const loading = computed(() => !timedOut.value && !store.state && ['idle', 'loading'].includes(store.runtimeStatus))
  function clearTimers() { clearTimeout(slowTimer); clearTimeout(endTimer) }
  watch(loading, waiting => {
    clearTimers(); slow.value = false
    if (waiting) { slowTimer = setTimeout(() => { slow.value = true }, SLOW_MS); endTimer = setTimeout(() => { timedOut.value = true; slow.value = false }, GIVE_UP_MS) }
  }, { immediate: true })
  async function retry() {
    if (retrying.value) return
    timedOut.value = false; retrying.value = true
    try {
      await store.refresh()
      if (store.runtimeStatus === 'ready') onReady()
      else if (store.refreshError === 'timeout') timedOut.value = true
    } finally { retrying.value = false }
  }
  onMounted(() => { if (store.runtimeStatus === 'idle') void store.refresh() })
  onBeforeUnmount(clearTimers)

  const failed = computed(() => timedOut.value || !store.state || denied.value)
  // The scope could not be read: say why in words, the way the person can act on it.
  const problem = computed(() => {
    if (denied.value) return { title: t('overview.read.denied'), detail: '' }
    if (timedOut.value || store.refreshError === 'timeout') return { title: t('problem.timeout.title'), detail: t('problem.timeout.detail') }
    if (store.runtimeStatus !== 'ready') return { title: t('problem.serviceDown.title'), detail: t('problem.serviceDown.detail') }
    return { title: t('problem.failed.title'), detail: t('problem.failed.detail') }
  })
  const error = computed(() => store.refreshError === 'failed' ? store.refreshMessage || null : null)
  return { loading, slow, failed, retrying, retry, problem, error }
}
