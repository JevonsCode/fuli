import { onBeforeUnmount, ref } from 'vue'

const SHAKE_AFTER_MS = 2000
const ENTER_AFTER_MS = 3000

// Holding a control down does something else than clicking it: it starts to
// shake after two seconds and acts at three. Letting go earlier changes
// nothing, so an ordinary click stays an ordinary click; once the hold has
// acted, the click its release fires is swallowed.
export function useHold(onHeld: () => void) {
  const shaking = ref(false)
  let shakeTimer: ReturnType<typeof setTimeout> | undefined
  let enterTimer: ReturnType<typeof setTimeout> | undefined
  let held = false

  function release() {
    clearTimeout(shakeTimer)
    clearTimeout(enterTimer)
    shaking.value = false
  }

  function onPointerdown(event: PointerEvent) {
    if (event.button !== 0) return
    release()
    held = false
    shakeTimer = setTimeout(() => { shaking.value = true }, SHAKE_AFTER_MS)
    enterTimer = setTimeout(() => {
      held = true
      release()
      onHeld()
    }, ENTER_AFTER_MS)
  }

  function onClickCapture(event: MouseEvent) {
    if (!held) return
    held = false
    event.preventDefault()
    event.stopPropagation()
  }

  onBeforeUnmount(release)
  return { shaking, handlers: { onPointerdown, onPointerup: release, onPointerleave: release, onPointercancel: release, onClickCapture } }
}
