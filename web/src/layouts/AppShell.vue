<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, watch, watchEffect } from 'vue'
import { MotionConfig } from 'motion-v'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import BrandEasterEgg from '@/components/BrandEasterEgg.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import { AGENT_PINS_KEY, useAgentPins } from '@/features/agent-profile/agent-pins'
import CaptureOnboardingDialog from '@/features/capture/CaptureOnboardingDialog.vue'
import DoctorBanner from '@/features/doctor/DoctorBanner.vue'
import GlossaryLayer from '@/features/glossary/GlossaryLayer.vue'
import GlossaryToggle from '@/features/glossary/GlossaryToggle.vue'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { t } from '@/i18n'
import { SPRING, motionConfigReduced } from '@/lib/motion'
import { routeMetaText, updateDocumentTitle } from '@/router/meta'
import { useConsoleStore } from '@/stores/console'
import { UiIcon, UiIconButton, UiNotice } from '@/ui'
import { FULI_VERSION } from '@/version'
import AppDock from './AppDock.vue'
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
// The dock stays open on the workbench and folds elsewhere.
const dockFolded = computed(() => destination.value?.key !== 'constellation')
const runtimeReady = computed(() => store.runtimeStatus === 'ready')
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

// Pins are shared by the dock, Agent cards and profiles.
provide(AGENT_PINS_KEY, useAgentPins(activeSpaceId))

// The waiting-requests badge in the top bar stays fresh while the page is visible.
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
  <MotionConfig :reduced-motion="motionConfigReduced" :transition="SPRING">
  <div class="app-frame">
    <header class="app-topbar">
      <div class="app-topbar-inner">
        <div class="app-brand">
          <BrandEasterEgg compact />
          <span class="app-wordmark">{{ t('shell.brand') }}</span>
          <!-- The service dot says ready on its own; its words show only when the service is not ready. -->
          <span class="app-runtime" :class="{ 'is-ready': runtimeReady }" role="status"
            :title="`${t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline')} · v${FULI_VERSION}`" data-runtime>
            <span class="app-runtime-dot" aria-hidden="true" />
            <span class="app-runtime-text" :class="{ 'is-visible': !runtimeReady }">{{ t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline') }}</span>
          </span>
        </div>
        <h1 class="app-title">{{ title }}</h1>
        <SectionTabs :sections="sectionTabs" :active-key="section?.key" />
        <div class="app-actions">
          <GlossaryToggle />
          <LocaleSwitcher />
          <UiIconButton icon="refresh" :label="t('common.actions.refresh')" :disabled="store.runtimeStatus === 'loading'" data-shell-refresh @click="refreshConsole" />
          <RouterLink to="/inbox" class="app-round" :aria-label="attention.total ? t('shell.attentionBadge', { count: attention.total }) : t('shell.sections.askedYou')"
            :title="t('shell.sections.askedYou')" data-shell-inbox data-term="section.askedYou">
            <UiIcon name="tray" :size="18" />
            <span v-if="attention.total" class="app-badge" aria-hidden="true" data-attention-badge>{{ attention.total > 9 ? '9+' : attention.total }}</span>
          </RouterLink>
          <RouterLink to="/settings" class="app-round" :class="{ 'is-active': settingsActive }" :aria-current="settingsActive ? 'page' : undefined"
            :aria-label="t('shell.destinations.settings')" :title="t('shell.destinations.settings')" data-destination="settings" data-term="destination.settings">
            <UiIcon name="settings" :size="18" />
          </RouterLink>
        </div>
      </div>
    </header>
    <main class="app-main" :data-layout="layout">
      <div class="app-feedback-row app-doctor-row">
        <div class="app-feedback-inner"><DoctorBanner /></div>
      </div>
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
    <AppDock :destinations="dockDestinations" :active-key="destination?.key" :space-id="activeSpaceId" :folded="dockFolded" />
  </div>
  </MotionConfig>
</template>

<style scoped>
/* The page root (.view) is the scroll container: body never scrolls, so the
   main column keeps a fixed height and lets the routed page take the rest.
   The frame paints the wash every glass panel sits on: static gradients, so
   only the dock and the pins capsule pay for a live blur. */
.app-frame {
  display: flex; flex-direction: column; height: 100dvh; overflow: hidden; color: var(--color-ink);
  background:
    radial-gradient(42% 55% at 10% 90%, var(--backdrop-2) 0%, transparent 70%),
    radial-gradient(45% 50% at 90% 10%, var(--backdrop-1) 0%, transparent 70%),
    radial-gradient(40% 45% at 70% 98%, var(--backdrop-3) 0%, transparent 70%),
    radial-gradient(35% 40% at 28% 6%, var(--backdrop-3) 0%, transparent 70%),
    var(--color-bg);
}
.app-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
/* Every page keeps its last lines clear of the floating dock. */
.app-main :deep(.view) { padding-bottom: calc(40px + 72px); }
.app-topbar { flex: 0 0 auto; padding: 12px var(--page-gutter) 8px; }
.app-topbar-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; max-width: var(--canvas-max); min-height: 44px; margin-inline: auto; }
.app-brand { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.app-wordmark { color: var(--color-ink); font-size: 18px; font-weight: 700; letter-spacing: -.02em; white-space: nowrap; }
.app-runtime { display: inline-flex; align-items: center; gap: 6px; --runtime: var(--status-error); }
.app-runtime.is-ready { --runtime: var(--color-success); }
.app-runtime-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--runtime); }
.app-runtime-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.app-runtime-text.is-visible { position: static; width: auto; height: auto; overflow: visible; clip-path: none; color: var(--runtime); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.app-title { min-width: 0; margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-title); letter-spacing: -.01em; overflow-wrap: anywhere; }
.app-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
/* Round glass buttons for the top-right destinations. */
.app-round {
  position: relative; display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid var(--edge-glass); border-radius: 50%;
  color: var(--color-muted); background: var(--surface-glass-strong); text-decoration: none; box-shadow: var(--shadow-xs);
  transition: color var(--motion-fast), background var(--motion-fast);
}
.app-round:hover { color: var(--color-ink); }
.app-round.is-active { color: var(--color-on-accent); background: var(--color-accent); }
.app-badge {
  position: absolute; top: -2px; right: -2px; display: grid; min-width: 16px; height: 16px; padding: 0 4px; place-items: center;
  border-radius: var(--radius-pill); color: #fff; background: var(--color-danger); box-shadow: 0 0 0 2px var(--color-surface);
  font-size: 10px; font-weight: var(--weight-strong); line-height: 1; font-variant-numeric: tabular-nums;
}
.app-feedback-row { flex: 0 0 auto; padding: 0 var(--page-gutter) 8px; }
/* The doctor's row takes no space while FULI needs nothing from the person. */
.app-doctor-row:has(> .app-feedback-inner:empty) { display: none; }
/* Canvas and form pages: the top bar and feedback line up with the page's
   centred column. A long record name takes at most two lines. */
.app-main[data-layout] { --layout-max: var(--canvas-max); }
.app-main[data-layout="form"] { --layout-max: var(--form-measure); }
.app-main[data-layout] .app-feedback-row { overflow: hidden; scrollbar-gutter: stable; }
.app-main[data-layout] .app-feedback-inner { max-width: var(--canvas-max); margin-inline: auto; }
.app-title { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
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
</style>
