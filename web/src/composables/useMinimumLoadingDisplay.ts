import { onBeforeUnmount, readonly, ref, watch, type Ref } from 'vue'

export const LOADING_VISIBILITY_DELAY_MS = 120
export const MINIMUM_LOADING_DISPLAY_MS = 180
export const LOADING_PREVIEW_QUERY = 'testLoading'

export function isLoadingPreviewEnabled(
  search = typeof window === 'undefined' ? '' : window.location.search,
) {
  return new URLSearchParams(search).get(LOADING_PREVIEW_QUERY) === '1'
}

export function useMinimumLoadingDisplay(
  active: Readonly<Ref<boolean>>,
  minimumMs = MINIMUM_LOADING_DISPLAY_MS,
) {
  const visible = ref(false)
  const displayMinimumMs = Math.max(0, minimumMs)
  const visibilityDelayMs = isLoadingPreviewEnabled() ? 0 : LOADING_VISIBILITY_DELAY_MS
  let visibleSince = 0
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let timerGeneration = 0
  let unmounted = false

  function cancelScheduledTimers() {
    timerGeneration += 1
    if (showTimer !== null) {
      clearTimeout(showTimer)
      showTimer = null
    }
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function scheduleShow() {
    if (visibilityDelayMs === 0) {
      if (unmounted || !active.value || visible.value) return
      visibleSince = Date.now()
      visible.value = true
      return
    }

    const generation = timerGeneration
    showTimer = setTimeout(() => {
      if (generation !== timerGeneration) return
      showTimer = null
      if (unmounted || !active.value || visible.value) return
      visibleSince = Date.now()
      visible.value = true
    }, visibilityDelayMs)
  }

  function scheduleHide() {
    const remaining = Math.max(0, displayMinimumMs - (Date.now() - visibleSince))
    if (remaining === 0) {
      visible.value = false
      visibleSince = 0
      return
    }

    const generation = timerGeneration
    hideTimer = setTimeout(() => {
      if (generation !== timerGeneration) return
      hideTimer = null
      if (unmounted || active.value) return
      visible.value = false
      visibleSince = 0
    }, remaining)
  }

  watch(
    active,
    (nextActive) => {
      cancelScheduledTimers()

      if (nextActive) {
        if (!visible.value) scheduleShow()
        return
      }

      if (!visible.value) return
      scheduleHide()
    },
    { immediate: true, flush: 'sync' },
  )

  onBeforeUnmount(() => {
    unmounted = true
    cancelScheduledTimers()
  })

  return readonly(visible)
}
