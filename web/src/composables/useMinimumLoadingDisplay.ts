import { onBeforeUnmount, readonly, ref, watch, type Ref } from 'vue'

export const MINIMUM_LOADING_DISPLAY_MS = 500
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
  let visibleSince = 0
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  function cancelScheduledHide() {
    if (hideTimer === null) return
    clearTimeout(hideTimer)
    hideTimer = null
  }

  watch(
    active,
    (nextActive) => {
      cancelScheduledHide()

      if (nextActive) {
        if (!visible.value) visibleSince = Date.now()
        visible.value = true
        return
      }

      if (!visible.value) return
      const remaining = Math.max(0, minimumMs - (Date.now() - visibleSince))
      if (remaining === 0) {
        visible.value = false
        return
      }

      hideTimer = setTimeout(() => {
        hideTimer = null
        visible.value = false
      }, remaining)
    },
    { immediate: true, flush: 'sync' },
  )

  onBeforeUnmount(cancelScheduledHide)

  return readonly(visible)
}
