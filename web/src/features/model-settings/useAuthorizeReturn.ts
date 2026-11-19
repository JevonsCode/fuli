import { watch, type Ref } from 'vue'

// 去授权 on a model use (rec issue 143): the button opens Astro's settings at the
// projects that may be sent to its model. When those settings close, saved or
// not, the person is back where they were: its 「查看详情」 opens again at
// once if it was open, and the use reads its state again behind it, so the
// projects they just approved appear when the read answers.
export function useAuthorizeReturn(settingsOpen: () => boolean, details: Ref<boolean>, reload: () => Promise<unknown>, openSettings: () => void) {
  let reopenDetails: boolean | null = null
  watch(settingsOpen, async (open, wasOpen) => {
    if (open || !wasOpen || reopenDetails === null) return
    const reopen = reopenDetails
    reopenDetails = null
    if (reopen) details.value = true
    await reload()
  })
  return () => {
    reopenDetails = details.value
    details.value = false
    openSettings()
  }
}
