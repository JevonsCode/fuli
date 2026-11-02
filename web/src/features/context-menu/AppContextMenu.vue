<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@/components/ui/context-menu'
import { t } from '@/i18n'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { agentPinsText } from '@/features/agent-profile/agent-pins'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
import { useAgentWorkSurfaces } from '@/features/agent-profile/use-agent-work-surfaces'
import { usePortraitShake } from '@/features/agent-profile/use-portrait-shake'
import { useConsoleStore } from '@/stores/console'
import { getJson } from '@/api/client'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { projectAgentShape } from '@/features/agent-profile/agent-record-shape'
import type { ProjectAgentRecord } from '@/types'
import { readContextTarget, type ContextTarget } from './context-target'
import { replaceFieldRange, selectAllInField } from './field-edit'

// The app's one right-click menu (Jevons 11-01): the WebView's native menu
// never shows. A right-click on selected text, a text field or a link opens
// this glass menu with what makes sense there; anywhere else, nothing opens.
// A component with its own right-click menu (the dock's pins) or the glossary
// mode claims the event first and keeps it. Every FLA portrait in the console
// (`data-agent-portrait`) gets the dock pins' menu here, and a click on one
// gives it a short shake (Jevons 11-02).
type MenuAction = 'cut' | 'copy' | 'paste' | 'selectAll' | 'open' | 'copyLink'

const router = useRouter()
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const work = useAgentWorkSurfaces(spaceId)
const { shake } = usePortraitShake()
const agentTarget = computed(() => target.value?.kind === 'agent' ? target.value : null)
// A portrait names only its FLA's id: the menu reads that FLA's record for its name and,
// with it, where its workbench and workflows are. Records read once stay for the visit.
const agents = ref<Record<string, ProjectAgentRecord | 'missing'>>({})
const agentName = (agentId: string) => { const record = agents.value[agentId]; return record && record !== 'missing' ? agentDisplayName(record) : agentId }
async function readAgent(agentId: string) {
  if (!agents.value[agentId]) {
    try {
      agents.value[agentId] = await getJson(`/api/project-agents/${encodeURIComponent(agentId)}?${new URLSearchParams({ personalSpaceId: spaceId.value })}`,
        projectAgentShape)
    } catch {
      agents.value[agentId] = 'missing'
    }
  }
  const record = agents.value[agentId]
  if (record !== 'missing') void work.open(record)
}
function goAgent(to: Parameters<typeof router.push>[0]) { void router.push(to) }
function onPortraitClick(event: MouseEvent) {
  const portrait = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-agent-portrait]') : null
  // The face around the picture (its only child) shakes, so a round, clipped portrait moves as one.
  const face = portrait?.parentElement?.childElementCount === 1 ? portrait.parentElement : portrait
  if (face) shake(face)
}
const open = ref(false)
const point = ref({ x: 0, y: 0 })
const target = ref<ContextTarget | null>(null)
let returnFocus: HTMLElement | null = null
let dismissedOutside = false

const actions = computed<MenuAction[]>(() => {
  if (target.value?.kind === 'field') return target.value.actions
  if (target.value?.kind === 'text') return ['copy']
  if (target.value?.kind === 'link') return ['open', 'copyLink']
  return []
})

// 粘贴 is hidden where reading the clipboard was refused, never shown dead. A browser that does
// not report the permission (Firefox, Safari) keeps it, and asks when it is used.
let clipboardRead: PermissionStatus | null = null
async function watchClipboardRead() {
  try {
    clipboardRead = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })
  } catch {
    clipboardRead = null
  }
}
const canPaste = () => typeof globalThis.navigator?.clipboard?.readText === 'function' && clipboardRead?.state !== 'denied'
const insideMenu = (node: EventTarget | null) => node instanceof Node && Boolean(document.querySelector('[data-app-context-menu]')?.contains(node))

// The point the menu opens at; the context-menu key reports none, so the menu opens under the focused element.
function menuPoint(event: MouseEvent) {
  if (event.clientX || event.clientY || !(event.target instanceof Element)) return { x: event.clientX, y: event.clientY }
  const box = event.target.getBoundingClientRect()
  return { x: box.left, y: box.bottom }
}

async function onContextMenu(event: MouseEvent) {
  const found = readContextTarget(event.target, { selection: window.getSelection(), origin: window.location.origin, canPaste: canPaste() })
  // A component's own menu decides a tick later (reka-ui's trigger does); let it claim the event first.
  await nextTick()
  if (event.defaultPrevented) return
  event.preventDefault()
  if (insideMenu(event.target)) return
  open.value = false
  if (!found) return
  await nextTick()
  target.value = found
  if (found.kind === 'agent') void readAgent(found.agentId)
  point.value = menuPoint(event)
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dismissedOutside = false
  open.value = true
}

function onInteractOutside() { dismissedOutside = true }
function close() { open.value = false }
function onScroll(event: Event) { if (open.value && !insideMenu(event.target)) close() }

// Focus goes back where it was (the field keeps typing), unless the menu closed because the person clicked elsewhere.
function onCloseAutoFocus(event: Event) {
  event.preventDefault()
  if (!dismissedOutside && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  returnFocus = null
}

function inAppPath(url: URL) {
  const base = router.options.history.base
  const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname
  return `${path}${url.search}${url.hash}`
}

function writeClipboard(text: string) {
  void globalThis.navigator?.clipboard?.writeText(text).catch(() => {})
}

type FieldTarget = Extract<ContextTarget, { kind: 'field' }>

// The field changes only once the clipboard answered: a refused read leaves it as it was, and a cut keeps its text.
async function paste(current: FieldTarget) {
  try {
    replaceFieldRange(current.field, current.range, await navigator.clipboard.readText())
  } catch {
    // The person refused the browser's request to read the clipboard.
  }
}
async function cut(current: FieldTarget) {
  try {
    await navigator.clipboard.writeText(current.selected)
    replaceFieldRange(current.field, current.range, '')
  } catch {
    // Writing was refused; the text stays in the field.
  }
}

function run(action: MenuAction) {
  const current = target.value
  // A portrait's menu runs its own items (goAgent), never these.
  if (!current || current.kind === 'agent') return
  if (current.kind === 'link') {
    if (action === 'copyLink') return writeClipboard(current.url.href)
    // An outside link opens the way the app opens every outside link: a new window, which the desktop client hands to the browser.
    if (current.internal) void router.push(inAppPath(current.url))
    else window.open(current.url.href, '_blank', 'noopener,noreferrer')
    return
  }
  if (current.kind === 'text') return writeClipboard(current.text)
  if (action === 'copy') return writeClipboard(current.selected)
  if (action === 'cut') return void cut(current)
  if (action === 'paste') return void paste(current)
  selectAllInField(current.field)
}

onMounted(() => {
  void watchClipboardRead()
  window.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('click', onPortraitClick, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
})
onBeforeUnmount(() => {
  window.removeEventListener('contextmenu', onContextMenu)
  window.removeEventListener('click', onPortraitClick, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <ContextMenu :open="open" :modal="false" @update:open="open = $event">
    <!-- The menu's anchor: a point where the right-click landed. -->
    <ContextMenuTrigger as-child>
      <span class="app-context-anchor" :style="{ left: `${point.x}px`, top: `${point.y}px` }" aria-hidden="true" />
    </ContextMenuTrigger>
    <ContextMenuContent class="app-context-menu" :collision-padding="8" data-app-context-menu
      @close-auto-focus="onCloseAutoFocus" @interact-outside="onInteractOutside">
      <template v-if="agentTarget">
        <ContextMenuLabel>{{ agentName(agentTarget.agentId) }}</ContextMenuLabel>
        <ContextMenuItem data-portrait-action="home" @select="goAgent({ path: agentProfilePath(spaceId, agentTarget.agentId), query: { tab: 'overview' } })">
          {{ agentPinsText('menu.home', 'Open profile') }}
        </ContextMenuItem>
        <ContextMenuItem v-if="work.surfaces.value[agentTarget.agentId]?.status === 'loading'" disabled>
          <GrowthLoading variant="inline" :label="t('agentPins.menu.reading', { name: agentName(agentTarget.agentId) })" />
        </ContextMenuItem>
        <ContextMenuItem v-else-if="work.surfaces.value[agentTarget.agentId]?.status === 'error'" disabled>
          {{ t('agentPins.menu.readError', { name: agentName(agentTarget.agentId) }) }}
        </ContextMenuItem>
        <ContextMenuItem v-if="work.ready(agentTarget.agentId)?.workbench" data-portrait-action="workbench" @select="goAgent(work.ready(agentTarget.agentId)!.workbench!)">
          {{ agentPinsText('menu.workbench', 'Open Workbench') }}
        </ContextMenuItem>
        <ContextMenuItem v-if="work.ready(agentTarget.agentId)?.workflow" data-portrait-action="workflow" @select="goAgent(work.ready(agentTarget.agentId)!.workflow!)">
          {{ agentPinsText('menu.workflow', 'Open Workflow') }}
        </ContextMenuItem>
      </template>
      <ContextMenuItem v-for="action in actions" v-else :key="action" :data-context-action="action" @select="run(action)">
        {{ t(`contextMenu.${action}`) }}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>

<style>
.app-context-anchor { position: fixed; width: 0; height: 0; }
/* Frosted glass like the dock and its pins: the glass on its own layer, so the
   menu blurs the page beneath it. */
.app-context-menu {
  position: relative; isolation: isolate; min-width: 8.5rem;
  border-color: var(--edge-dock); background: transparent; box-shadow: var(--shadow-glass);
  user-select: none; -webkit-user-select: none;
  animation: app-context-menu-in var(--motion-enter);
}
.app-context-menu::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  background: var(--glass-sheen), var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .app-context-menu::before { background: var(--color-surface); }
}
/* Scale only, no fade: a fading panel cannot blur what lies beneath it until it is opaque. */
@keyframes app-context-menu-in { from { scale: .96; translate: 0 2px; } }
</style>
