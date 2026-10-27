<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, watch, watchEffect } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import { AGENT_PINS_KEY, useAgentPins } from '@/features/agent-profile/agent-pins'
import CaptureOnboardingDialog from '@/features/capture/CaptureOnboardingDialog.vue'
import DesignLabPanel from '@/features/design-lab/DesignLabPanel.vue'
import GlossaryLayer from '@/features/glossary/GlossaryLayer.vue'
import GlossaryToggle from '@/features/glossary/GlossaryToggle.vue'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { t } from '@/i18n'
import { routeMetaText, updateDocumentTitle } from '@/router/meta'
import { useConsoleStore } from '@/stores/console'
import { UiIconButton, UiNotice } from '@/ui'
import NavRail from './NavRail.vue'
import SectionTabs from './SectionTabs.vue'
import { activeDestination, activeSection, navDestinations } from './nav-destinations'
import { pageLayout } from './page-layout'
import { pageTitle } from './page-title'

// The console frame: icon rail (bottom bar on narrow screens), a top bar with
// the page's one H1 and the active destination's sections, and the routed page.
const store = useConsoleStore()
const route = useRoute()
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const destinations = computed(() => navDestinations({
  spaceId: activeSpaceId.value || 'current',
  publicProjects: store.state?.capabilities?.browsePublicProjects !== false,
}))
const destination = computed(() => activeDestination(destinations.value, route.path))
const section = computed(() => activeSection(destination.value, route.path))
// A page about one record names itself (an Agent's real name). Otherwise,
// anywhere inside a section the tabs already name it, so the heading names
// the destination (对话 beside 圆桌 | 待决策, 记忆 beside 知识 | 偏好) instead
// of repeating the active tab, on the section's deeper paths too (a selected
// conversation, an opened knowledge item). Everything else uses the route's
// meta.title.
const recordTitle = computed(() => pageTitle.value.path === route.path ? pageTitle.value.text : '')
const title = computed(() => recordTitle.value || (destination.value && destination.value.sections.length > 1 && section.value && !route.meta.detail
  ? t(`shell.destinations.${destination.value.key}`)
  : routeMetaText(route.meta.title, 'routes.overview.title')))
// Rebuilt pages share one centred width; the top bar lines its title up with
// it. A form page centres its fields at the narrower form measure inside it.
const layout = computed(() => pageLayout(route))
// A detail page names its record alone; the destination's tabs would read as
// tabs of that record. The rail still marks where it belongs.
const sectionTabs = computed(() => route.meta.detail ? [] : destination.value?.sections ?? [])
// Temporary: the design lab goes away once a design is chosen. It stays off
// pages where it would cover something fixed: a sticky save bar, a conversation.
const showsDesignLab = computed(() => route.name !== 'overview' && route.path !== '/preferences'
  && !route.path.startsWith('/roundtables') && route.meta.saveBar !== true)

// Pins are shared by the rail, Agent cards and profiles.
provide(AGENT_PINS_KEY, useAgentPins(activeSpaceId))

// The 对话 badge keeps the waiting count fresh while the page is visible.
const attention = useAgentAttention()
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
  <div class="app-frame">
    <NavRail :destinations="destinations" :active-key="destination?.key" :attention-count="attention.total"
      :runtime-ready="store.runtimeStatus === 'ready'" :space-id="activeSpaceId" />
    <main class="app-main" :data-layout="layout">
      <header class="app-topbar">
        <div class="app-topbar-inner">
          <h1 class="app-title">{{ title }}</h1>
          <SectionTabs :sections="sectionTabs" :active-key="section?.key" />
          <div class="app-actions">
            <GlossaryToggle />
            <LocaleSwitcher />
            <UiIconButton icon="refresh" :label="t('common.actions.refresh')" :disabled="store.runtimeStatus === 'loading'" data-shell-refresh @click="refreshConsole" />
          </div>
        </div>
      </header>
      <NavigationRecovery />
      <div v-if="store.feedback" class="app-feedback-row">
        <div class="app-feedback-inner">
          <UiNotice class="feedback-message" :tone="store.feedback.tone">
            {{ store.feedback.message }}
            <template #actions><UiIconButton icon="close" size="sm" :label="t('common.actions.close')" @click="store.clearFeedback" /></template>
          </UiNotice>
        </div>
      </div>
      <RouterView v-slot="{ Component }"><component :is="Component" /></RouterView>
      <GlossaryLayer />
      <CaptureOnboardingDialog />
    </main>
    <DesignLabPanel v-if="showsDesignLab" />
  </div>
</template>

<style scoped>
/* The page root (.view) is the scroll container: body never scrolls, so the
   main column keeps a fixed height and lets the routed page take the rest. */
.app-frame { display: flex; height: 100dvh; overflow: hidden; background: var(--color-bg); color: var(--color-ink); }
.app-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.app-topbar { flex: 0 0 auto; padding: 10px var(--page-gutter); }
.app-topbar-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; min-height: 44px; }
.app-title { min-width: 0; margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-title); letter-spacing: -.01em; overflow-wrap: anywhere; }
.app-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.app-feedback-row { flex: 0 0 auto; padding: 0 var(--page-gutter) 8px; }
/* Canvas and form pages: the top bar and feedback line up with the page's
   centred column. Both rows reserve the same scrollbar gutter as the page's
   scroll container, so the title starts exactly where the content does. A
   long record name takes at most two lines. */
.app-main[data-layout] { --layout-max: var(--canvas-max); }
/* A form page's content reads at the form measure, centred in the same page;
   its top bar stays at the page width, so switching tabs never moves it. */
.app-main[data-layout="form"] { --layout-max: var(--form-measure); }
.app-main[data-layout] :is(.app-topbar, .app-feedback-row) { overflow: hidden; scrollbar-gutter: stable; }
.app-main[data-layout] :is(.app-topbar-inner, .app-feedback-inner) { max-width: var(--canvas-max); margin-inline: auto; }
.app-main[data-layout] .app-title { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
/* A long record name wraps inside its own column instead of pushing the tabs
   and actions onto a second row, so the bar stays short on a laptop. */
@media (min-width: 721px) {
  .app-main[data-layout] .app-topbar-inner { flex-wrap: nowrap; }
  .app-main[data-layout] .app-title { flex: 0 1 auto; min-width: 0; }
  .app-main[data-layout] :is(.section-tabs, .app-actions) { flex-shrink: 0; }
}
@media (max-width: 720px) {
  .app-main { padding-bottom: calc(60px + env(safe-area-inset-bottom)); }
  .app-topbar-inner { min-height: 36px; }
  .app-title { font-size: 19px; }
  /* Title and actions share the first row; the section tabs take their own. */
  .app-topbar-inner > .section-tabs { order: 3; flex-basis: 100%; }
}
</style>
