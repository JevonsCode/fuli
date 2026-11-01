<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, watch, watchEffect } from 'vue'
import { MotionConfig } from 'motion-v'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import BrandEasterEgg from '@/components/BrandEasterEgg.vue'
import GrowingBackdrop from '@/components/GrowingBackdrop.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import { loadAgentLooks } from '@/features/agent-profile/agent-looks'
import { loadRoleNames } from '@/features/agent-profile/role-names'
import { AGENT_PINS_KEY, useAgentPins } from '@/features/agent-profile/agent-pins'
import CaptureOnboardingDialog from '@/features/capture/CaptureOnboardingDialog.vue'
import DoctorBanner from '@/features/doctor/DoctorBanner.vue'
import CopyFixPrompt from '@/features/problem/CopyFixPrompt.vue'
import GlossaryLayer from '@/features/glossary/GlossaryLayer.vue'
import GlossaryToggle from '@/features/glossary/GlossaryToggle.vue'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { currentLocale, t } from '@/i18n'
import { fuliWordmarkUrl } from '@/lib/brand'
import { vWindowDrag } from '@/lib/desktop-client'
import { SPRING, motionConfigReduced } from '@/lib/motion'
import { routeMetaText, updateDocumentTitle } from '@/router/meta'
import { useConsoleStore } from '@/stores/console'
import { UiIcon, UiIconButton, UiNotice } from '@/ui'
import { FULI_VERSION } from '@/version'
import AppDock from './AppDock.vue'
import WidgetSlot from '@/widgets/WidgetSlot.vue'
import SectionTabs from './SectionTabs.vue'
import { activeDestination, activeSection, navDestinations } from './nav-destinations'
import { pageLayout } from './page-layout'
import { pageTitle } from './page-title'

// The console frame (client redesign, 2026-11-01): a top bar with the brand,
// the page's one H1, the active destination's sections and the top-right
// actions (waiting requests, settings); the routed page; and the floating dock
// with the five main destinations. The page sits on a pre-blurred wash.
const store = useConsoleStore()
const route = useRoute()
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const destinations = computed(() => navDestinations({
  spaceId: activeSpaceId.value || 'current',
  publicProjects: store.state?.capabilities?.browsePublicProjects !== false,
}))
const destination = computed(() => activeDestination(destinations.value, route.path))
const section = computed(() => activeSection(destination.value, route.path))
const dockDestinations = computed(() => destinations.value.filter(item => item.placement === 'dock'))
const settingsActive = computed(() => destination.value?.key === 'settings')
// The dock stays open on the workbench and folds to the current destination
// elsewhere. A page outside the dock (settings) has nothing to fold to, so the
// dock stays open there instead of shrinking to an empty capsule.
const dockFolded = computed(() => destination.value?.placement === 'dock' && destination.value.key !== 'constellation')
const runtimeReady = computed(() => store.runtimeStatus === 'ready')
// A page about one record names itself (an Agent's real name). Otherwise,
// anywhere inside a section the tabs already name it, so the heading names
// the destination (对话 beside 圆桌 | 待决策, 记忆 beside 知识 | 偏好) instead
// of repeating the active tab, on the section's deeper paths too (a selected
// conversation, an opened knowledge item). Everything else uses the route's
// meta.title.
const recordTitle = computed(() => pageTitle.value.path === route.path ? pageTitle.value.text : '')
const titleInPage = computed(() => pageTitle.value.path === route.path && pageTitle.value.inPage)
const title = computed(() => recordTitle.value || (destination.value && destination.value.sections.length > 1 && section.value && !route.meta.detail
  ? t(`shell.destinations.${destination.value.key}`)
  : routeMetaText(route.meta.title, 'routes.overview.title')))
// Rebuilt pages share one centred width; the top bar lines its title up with
// it. A form page centres its fields at the narrower form measure inside it.
const layout = computed(() => pageLayout(route))
// A detail page names its record alone; the destination's tabs would read as
// tabs of that record. The rail still marks where it belongs.
const sectionTabs = computed(() => route.meta.detail ? [] : destination.value?.sections ?? [])

// Pins are shared by the dock, Agent cards and profiles.
provide(AGENT_PINS_KEY, useAgentPins(activeSpaceId))
// The looks the person chose for their Agents, read once for every portrait.
watch(activeSpaceId, id => void loadAgentLooks(id), { immediate: true })
// The names the built-in roles go by now, for every label that names one.
watch(activeSpaceId, id => void loadRoleNames(id), { immediate: true })

// The waiting-requests tray in the top bar stays fresh while the page is visible.
const attention = useAgentAttention()
const inboxLabel = computed(() => attention.total ? t('shell.attentionWaiting', { count: attention.total }) : t('shell.sections.askedYou'))
watch(activeSpaceId, id => attention.setSpace(id), { immediate: true })
let attentionTimer: ReturnType<typeof setInterval> | undefined
function refreshAttention() { if (document.visibilityState === 'visible' && !attention.loading && !attention.open) void attention.refresh() }
// The top bar's one refresh reads the console again and the waiting requests with it:
// the whole queue while the inbox is open, so that page needs no refresh of its own.
function refreshConsole() {
  void store.refresh()
  if (!attention.loading) void attention.refresh()
}
onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  attentionTimer = setInterval(refreshAttention, 30000)
  document.addEventListener('visibilitychange', refreshAttention)
})
onBeforeUnmount(() => {
  clearInterval(attentionTimer)
  document.removeEventListener('visibilitychange', refreshAttention)
  attention.setSpace('')
})
// Every navigation, a query change too, retitles the tab: the router's own
// afterEach writes the route title, so a record page names itself again.
watchEffect(() => {
  void route.fullPath
  updateDocumentTitle(recordTitle.value || route.meta.title)
})
</script>

<template>
  <MotionConfig :reduced-motion="motionConfigReduced" :transition="SPRING">
  <div class="app-frame">
    <GrowingBackdrop />
    <header v-window-drag class="app-topbar">
      <div class="app-topbar-inner">
        <div class="app-brand">
          <BrandEasterEgg compact />
          <img class="app-wordmark" :src="fuliWordmarkUrl(currentLocale())" :alt="t('shell.brand')" draggable="false" />
          <!-- The service dot says ready on its own; its words show only when the service is not ready. -->
          <span class="app-runtime" :class="{ 'is-ready': runtimeReady }" role="status"
            :title="`${t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline')} · v${FULI_VERSION}`" data-runtime>
            <span class="app-runtime-dot" aria-hidden="true" />
            <span class="app-runtime-text" :class="{ 'is-visible': !runtimeReady }">{{ t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline') }}</span>
          </span>
        </div>
        <!-- Only a record's own name is shown; a destination is already named by the dock
             (or the settings button), so its heading stays for screen readers only. -->
        <h1 v-if="!titleInPage" class="app-title" :class="{ 'is-screen-reader-only': !recordTitle }">{{ title }}</h1>
        <SectionTabs :sections="sectionTabs" :active-key="section?.key" />
        <div class="app-actions">
          <DoctorBanner />
          <GlossaryToggle />
          <LocaleSwitcher />
          <UiIconButton icon="refresh" :label="t('common.actions.refresh')" :disabled="store.runtimeStatus === 'loading'" data-shell-refresh @click="refreshConsole" />
          <!-- 待决策 is a tray: empty when nothing waits, with papers in it when something does. -->
          <RouterLink to="/inbox" class="app-round" :class="{ 'is-full': attention.total }" :aria-label="inboxLabel" :title="inboxLabel"
            :data-attention="attention.total ? 'full' : 'empty'" data-shell-inbox data-term="section.askedYou">
            <UiIcon :name="attention.total ? 'trayFull' : 'tray'" :size="18" />
          </RouterLink>
          <RouterLink to="/settings" class="app-round" :class="{ 'is-active': settingsActive }" :aria-current="settingsActive ? 'page' : undefined"
            :aria-label="t('shell.destinations.settings')" :title="t('shell.destinations.settings')" data-destination="settings" data-term="destination.settings">
            <UiIcon name="settings" :size="18" />
          </RouterLink>
        </div>
      </div>
    </header>
    <main class="app-main" :data-layout="layout">
      <NavigationRecovery />
      <div v-if="store.feedback" class="app-feedback-row">
        <div class="app-feedback-inner">
          <UiNotice class="feedback-message" :tone="store.feedback.tone">
            {{ store.feedback.message }}
            <template #actions>
              <CopyFixPrompt v-if="store.feedback.tone === 'error'" :what="store.feedback.message" />
              <UiIconButton icon="close" size="sm" :label="t('common.actions.close')" @click="store.clearFeedback" />
            </template>
          </UiNotice>
        </div>
      </div>
      <RouterView v-slot="{ Component }"><component :is="Component" /></RouterView>
      <GlossaryLayer />
      <CaptureOnboardingDialog />
    </main>
    <WidgetSlot place="shell.aboveDock" />
    <AppDock :destinations="dockDestinations" :active-key="destination?.key" :space-id="activeSpaceId" :folded="dockFolded" />
  </div>
  </MotionConfig>
</template>

<style scoped>
/* The page root (.view) is the scroll container: body never scrolls, so the
   main column keeps a fixed height and lets the routed page take the rest.
   The page itself is plain: surfaces and type carry the design (direction A). */
.app-frame { position: relative; isolation: isolate; display: flex; flex-direction: column; height: 100dvh; overflow: hidden; color: var(--color-ink); background: var(--color-bg); }
.app-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
/* Every page keeps its last lines clear of the floating dock. A page that
   ends with another block after its .view (项目's history card) keeps that
   space below the block instead, so no gap opens in the middle of the page. */
.app-main :deep(.view) { padding-bottom: var(--dock-clearance); }
.app-main :deep(.view:not(:last-child)) { padding-bottom: 0; }
/* The top bar is its own layer above the page, so what it opens (the doctor's panel) floats over the page's cards instead of under them. */
.app-topbar { position: relative; z-index: var(--z-popover); flex: 0 0 auto; padding: 12px var(--page-gutter) 8px; }
/* In the desktop client the bar is the window's title bar: its own minimise, maximise and
   close (Windows) or the traffic lights (macOS) sit in the top corners, so the bar keeps
   clear of them, and stays centred where the window is wide enough (lib/desktop-client.ts). */
:root[data-desktop-client] .app-topbar {
  padding-left: max(var(--page-gutter), min(var(--desktop-caption-start), calc(var(--page-gutter) + var(--canvas-max) + 2 * var(--desktop-caption-start) - 100%)));
  padding-right: max(var(--page-gutter), min(var(--desktop-caption-end), calc(var(--page-gutter) + var(--canvas-max) + 2 * var(--desktop-caption-end) - 100%)));
}
.app-topbar-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; max-width: var(--canvas-max); min-height: 44px; margin-inline: auto; }
.app-brand { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.app-wordmark { display: block; width: auto; height: 15px; user-select: none; }
.app-runtime { display: inline-flex; align-items: center; gap: 6px; --runtime: var(--status-error); }
.app-runtime.is-ready { --runtime: var(--color-success); }
.app-runtime-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--runtime); }
.app-runtime-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.app-runtime-text.is-visible { position: static; width: auto; height: auto; overflow: visible; clip-path: none; color: var(--runtime); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.app-title { min-width: 0; margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-title); letter-spacing: -.02em; overflow-wrap: anywhere; }
.app-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
/* Quiet round buttons for the top-right destinations; only the current one is ink. */
.app-round {
  position: relative; display: grid; width: 36px; height: 36px; place-items: center; border-radius: 50%;
  color: var(--color-ink-soft); background: transparent; text-decoration: none;
  transition: color var(--motion-fast), background var(--motion-fast);
}
.app-round:hover { color: var(--color-ink); background: var(--color-surface-hover); }
.app-round.is-active { color: var(--color-on-accent); background: var(--color-accent); }
/* A full tray reads in ink; its papers drop in when it fills (reduced motion zeroes this in primitives.css). */
.app-round.is-full { color: var(--color-ink); }
.app-round :deep(.tray-papers) { transform-box: fill-box; animation: tray-papers-in var(--motion-enter); }
@keyframes tray-papers-in { from { opacity: 0; transform: translateY(-5px); } }
.app-feedback-row { flex: 0 0 auto; padding: 0 var(--page-gutter) 8px; }
/* Canvas and form pages: the top bar and feedback line up with the page's
   centred column. A long record name takes at most two lines. */
.app-main[data-layout] { --layout-max: var(--canvas-max); }
.app-main[data-layout="form"] { --layout-max: var(--form-measure); }
.app-main[data-layout] .app-feedback-row { overflow: hidden; scrollbar-gutter: stable; }
.app-main[data-layout] .app-feedback-inner { max-width: var(--canvas-max); margin-inline: auto; }
.app-title.is-screen-reader-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.app-title:not(.is-screen-reader-only) { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
@media (min-width: 721px) {
  .app-topbar-inner { flex-wrap: nowrap; }
  .app-title { flex: 0 1 auto; min-width: 0; }
  .app-topbar-inner :is(.section-tabs, .app-actions, .app-brand) { flex-shrink: 0; }
}
@media (max-width: 720px) {
  .app-topbar-inner { min-height: 36px; }
  .app-title { font-size: 19px; }
  .app-wordmark { display: none; }
  /* Brand, title and actions share the first row; the section tabs take their own. */
  .app-topbar-inner > .section-tabs { order: 3; flex-basis: 100%; }
}
@media (prefers-reduced-motion: reduce) { .app-round { transition: none; } }
:root[data-motion="reduced"] .app-round { transition: none; }
</style>
