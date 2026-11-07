<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { employeeAvatarUrl } from '@/features/employees/avatars'
import { t } from '@/i18n'
import { agentAvatarUrl, defaultAvatarUrl } from './agent-avatar'
import { builtInRole, roleName } from './role-names'

// Every FLA and built-in role face in the console (Jevons 11-08: 「这种头像你可以都
// 封装一个组件吧，这个应该也能右键的啊」). The root is the <img> itself, so the place's
// own frame and sizing rules keep applying and nothing moves. `data-agent-portrait`
// hands it to the app's one portrait handler (AppContextMenu): the right-click menu,
// the click shake and, for a face marked `data-agent-link`, opening the FLA's page.
// Inside a link or button the face is part of that control, which keeps its click,
// focus and name, as does a place that handles the click itself (`:link="false"`).
// Anywhere else the face is the FLA's own link: a click or Enter opens its page and,
// unless the place hides it from assistive tech, it takes focus so Shift+F10 or the
// context-menu key opens its menu. A touch long-press opens the same menu.
const props = withDefaults(defineProps<{
  /** The Agent's ID, or a built-in role's template ID (`tonborg`, `assistant`, …). */
  agentId: string
  /** The name it goes by; built-in roles default to their current name. */
  name?: string | null
  /** False where the place's own click handles the face (a card that opens a quick look). */
  link?: boolean
}>(), { name: null, link: true })

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 8
const CONTROL = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], label, summary'

const element = ref<HTMLImageElement>()
const insideControl = ref(true)
const hidden = ref(true)
const failed = ref(false)

const id = computed(() => !props.agentId.includes('.') && employeeAvatarUrl(props.agentId) ? `employee.${props.agentId}` : props.agentId)
const src = computed(() => failed.value ? defaultAvatarUrl(id.value) : agentAvatarUrl(id.value))
const role = computed(() => builtInRole(id.value))
const label = computed(() => props.name?.trim() || (role.value ? roleName(role.value) : ''))
const standalone = computed(() => props.link && !insideControl.value)
const focusable = computed(() => standalone.value && !hidden.value && Boolean(label.value))
watch(id, () => { failed.value = false })

// The menu keys open the portrait menu under the face themselves: not every WebView
// turns them into a contextmenu event. With no point, the menu opens under the face.
function onKey(event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault()
    element.value?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return
  }
  if (event.key !== 'Enter' || !standalone.value) return
  event.preventDefault()
  element.value?.click()
}

// iOS never sends contextmenu for a long press, and an image's own callout would show
// instead: the press opens the app's menu itself. Where the browser does send one
// (Android), that native event wins and the timer stops.
let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null
let pressed = false
function endPress() {
  if (press) clearTimeout(press.timer)
  press = null
}
function onPointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse') return
  endPress()
  pressed = false
  const { clientX: x, clientY: y } = event
  press = { x, y, timer: setTimeout(() => {
    press = null
    pressed = true
    element.value?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  }, LONG_PRESS_MS) }
}
function onPointerMove(event: PointerEvent) {
  if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE) endPress()
}
function onContextMenu() {
  if (press) pressed = true
  endPress()
}
// The click that ends a long press only opened the menu: it neither follows a link nor opens the page.
function onClick(event: MouseEvent) {
  if (!pressed) return
  pressed = false
  event.preventDefault()
  event.stopPropagation()
}

onMounted(() => {
  const parent = element.value?.parentElement
  insideControl.value = Boolean(parent?.closest(CONTROL))
  hidden.value = Boolean(parent?.closest('[aria-hidden="true"]'))
})
onBeforeUnmount(endPress)
</script>

<template>
  <img ref="element" class="agent-avatar" :src="src" :alt="focusable ? label : ''" draggable="false"
    :data-agent-portrait="id" :data-agent-link="standalone || undefined"
    :role="focusable ? 'link' : undefined" :tabindex="focusable ? 0 : undefined"
    :aria-label="focusable ? t('contextMenu.openAgent', { name: label }) : undefined"
    @error="failed = true" @click="onClick" @keydown="onKey" @contextmenu="onContextMenu"
    @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="endPress" @pointercancel="endPress" />
</template>

<style scoped>
/* A face is never picked up as text or an image: no selection, no drag, no iOS callout. */
.agent-avatar { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-user-drag: none; }
.agent-avatar[data-agent-link] { cursor: pointer; }
/* Inside the face: the frame around it often clips, and an outside ring would be cut. */
.agent-avatar:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
</style>
