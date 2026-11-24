<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { employeeAvatarUrl } from '@/features/employees/avatars'
import { t } from '@/i18n'
import { agentAvatarUrl, defaultAvatarUrl } from './agent-avatar'
import { isRemoteAgentId, remoteAvatarUrl, remoteFaces } from './remote-faces'
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
const COMPACT_RING_PX = 20
const REMOTE_NAME_CHARS = 80
const MOVE_TOLERANCE = 8
const CONTROL = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], label, summary'

const element = ref<HTMLImageElement>()
const insideControl = ref(true)
const hidden = ref(true)
const failed = ref(false)

// An FLA on another computer (`peer:` address) shows the face it has there, a
// ring on its frame (`data-agent-remote`, below) and the computer in its name. It
// has no page or menu here, so it is never a link and never the portrait menu's.
const remote = computed(() => isRemoteAgentId(props.agentId))
const id = computed(() => !remote.value && !props.agentId.includes('.') && employeeAvatarUrl(props.agentId) ? `employee.${props.agentId}` : props.agentId)
const src = computed(() => remote.value ? remoteAvatarUrl(id.value) : failed.value ? defaultAvatarUrl(id.value) : agentAvatarUrl(id.value))
const role = computed(() => remote.value ? null : builtInRole(id.value))
const label = computed(() => props.name?.trim() || (role.value ? roleName(role.value) : ''))
const standalone = computed(() => props.link && !insideControl.value && !remote.value)
const focusable = computed(() => standalone.value && !hidden.value && Boolean(label.value))
const remoteLabel = computed(() => {
  if (!remote.value) return ''
  const face = remoteFaces.value.get(id.value)
  const name = label.value || face?.name || t('roundtable.unknownAgent')
  // A sender's name from another computer already ends with that computer.
  const who = face?.device && !name.endsWith(face.device) ? `${name} · ${face.device}` : name
  return t('agentProfiles.remoteFace', { name: who.length > REMOTE_NAME_CHARS ? `${who.slice(0, REMOTE_NAME_CHARS - 1)}…` : who })
})
// Below this width the dashed ring would read as dots; the ring turns plain there.
const ring = ref<'framed' | 'compact'>('framed')
function measureRing() {
  const width = element.value?.getBoundingClientRect().width ?? 0
  ring.value = width > 0 && width < COMPACT_RING_PX ? 'compact' : 'framed'
}
watch(id, () => { failed.value = false })
watch(remote, value => { if (value) measureRing() })

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
  if (remote.value) measureRing()
})
onBeforeUnmount(endPress)
</script>

<template>
  <img ref="element" class="agent-avatar" :src="src" :alt="remote ? (hidden ? '' : remoteLabel) : focusable ? label : ''" draggable="false"
    :title="remote ? remoteLabel : undefined" :data-agent-remote="remote ? ring : undefined"
    :data-agent-portrait="remote ? undefined : id" :data-agent-link="standalone || undefined"
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

<style>
/* An FLA on another computer: the picture stays its own; its frame gets a dashed
   ring in the quiet ink, just outside, so nothing moves and the frame's clipping
   cannot cut it. The frame is the face's only-child wrapper (as the portrait
   shake assumes); a face without one carries the ring itself. Small faces get a
   plain 1px ring, which still reads where dashes would turn to dots. Status marks
   use colour dots and badges, never a ring in this ink. */
:where(*):has(> img.agent-avatar[data-agent-remote]:only-child),
img.agent-avatar[data-agent-remote]:not(:only-child) {
  outline: 1.5px dashed var(--color-muted);
  outline-offset: 1.5px;
}
:where(*):has(> img.agent-avatar[data-agent-remote="compact"]:only-child),
img.agent-avatar[data-agent-remote="compact"]:not(:only-child) {
  outline: 1px solid var(--color-muted);
  outline-offset: 1px;
}
</style>
