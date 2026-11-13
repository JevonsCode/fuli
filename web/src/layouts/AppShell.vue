<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { MotionConfig } from 'motion-v'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import BrandEasterEgg from '@/components/BrandEasterEgg.vue'
import GrowingBackdrop from '@/components/GrowingBackdrop.vue'
import HeaderPeek from '@/components/HeaderPeek.vue'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import { loadAgentLooks } from '@/features/agent-profile/agent-looks'
import { loadPersonProfile } from '@/features/person-home/person-profile'
import { loadRoleNames } from '@/features/agent-profile/role-names'
import { AGENT_PINS_KEY, useAgentPins } from '@/features/agent-profile/agent-pins'
import CaptureOnboardingDialog from '@/features/capture/CaptureOnboardingDialog.vue'
import OnboardingTour from '@/features/onboarding-tour/OnboardingTour.vue'
import ModelPowerButton from '@/features/model-settings/ModelPowerButton.vue'
import DoctorBanner from '@/features/doctor/DoctorBanner.vue'
import { clientsNeedUpdate } from '@/features/doctor/doctor-report'
import GlossaryLayer from '@/features/glossary/GlossaryLayer.vue'
import GlossaryToggle from '@/features/glossary/GlossaryToggle.vue'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import OpenInAppButton from '@/features/open-in-app/OpenInAppButton.vue'
import { shellPageTools } from '@/features/webmcp/shell-page-tools'
import { usePageTools } from '@/features/webmcp/usePageTools'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { useReviewList } from '@/features/review-list/review-store'
import { offersUpdate, readVersionStatus } from '@/features/update/version-status'
import { useRoundtableLive } from '@/features/roundtables/roundtable-live'
import { t } from '@/i18n'
import { fuliWordmarkUrl } from '@/lib/brand'
import { vWindowDrag } from '@/lib/desktop-client'
import { useHold } from '@/lib/use-hold'
import { SPRING, motionConfigReduced } from '@/lib/motion'
import { routeMetaText, updateDocumentTitle } from '@/router/meta'
import { useConsoleStore } from '@/stores/console'
import { UiIcon, UiIconButton } from '@/ui'
import FeedbackToast from './FeedbackToast.vue'
import CornerNotices from './CornerNotices.vue'
import InboxPeek from './InboxPeek.vue'
import { FULI_VERSION } from '@/version'
import AppDock from './AppDock.vue'
import WidgetSlot from '@/widgets/WidgetSlot.vue'
import SectionTabs from './SectionTabs.vue'
import { activeDestination, activeSection, navDestinations } from './nav-destinations'
import { pageTitle } from './page-title'
import { reloadPage } from './page-refresh'
import { measureScrollbarSize } from './scrollbar-size'

// The console frame (client redesign, 2026-11-01): a top bar with the brand,
// the page's one H1, the active destination's sections and the top-right
// actions (waiting requests, settings); the routed page; and the floating dock
// with the five main destinations. The page sits on a pre-blurred wash.
const store = useConsoleStore()
const route = useRoute()
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const destinations = computed(() => navDestinations({ spaceId: activeSpaceId.value || 'current' }))
const destination = computed(() => activeDestination(destinations.value, route.path))
const section = computed(() => activeSection(destination.value, route.path))
const dockDestinations = computed(() => destinations.value.filter(item => item.placement === 'dock'))
const settingsActive = computed(() => destination.value?.key === 'settings')
// 待决策 is lit on its own page, like 设置 and the model button on theirs.
const inboxActive = computed(() => route.path === '/inbox' || route.path.startsWith('/inbox/'))
// Holding the settings button opens the #fulidebug records (Jevons 11-04): nothing in Settings names them.
const router = useRouter()
// What every page offers the browser's AI agent (WebMCP) where the browser supports it.
usePageTools(() => shellPageTools({ router, spaceId: () => activeSpaceId.value }))
// The mark and the wordmark: on 今天 they play the mark's effect; on any other
// page they go back to it (Jevons 11-04).
const brand = ref<InstanceType<typeof BrandEasterEgg> | null>(null)
const onHome = computed(() => route.path === '/')
const brandLabel = computed(() => onHome.value ? t('console.brandEffect.aria') : t('shell.destinations.constellation'))
function pressBrand() {
  if (onHome.value) brand.value?.play()
  else void router.push('/')
}
const settingsHold = useHold(() => { void router.push('/debug') })
// A client whose FULI integration needs an update is a dot on 设置 (from the doctor DoctorBanner
// already reads), and 设置 then opens on 客户端, where 「更新」 is.
const settingsTo = computed(() => clientsNeedUpdate.value ? '/settings?tab=clients' : '/settings')
const settingsLabel = computed(() => t(clientsNeedUpdate.value ? 'shell.settingsClientsUpdate' : 'shell.destinations.settings'))
// The dock stays open on the workbench and folds to the current destination
// elsewhere. A page outside the dock (settings) has nothing to fold to, so the
// dock stays open there instead of shrinking to an empty capsule.
// The 圆桌 icon animates while an Agent is replying in one of its conversations.
const roundtableLive = useRoundtableLive(activeSpaceId)
const liveDockKey = computed(() => roundtableLive.value ? 'chat' : null)
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
// A detail page names its record alone; the destination's tabs would read as
// tabs of that record. The rail still marks where it belongs.
const sectionTabs = computed(() => route.meta.detail ? [] : destination.value?.sections ?? [])

// Pins are shared by the dock, Agent cards and profiles.
provide(AGENT_PINS_KEY, useAgentPins(activeSpaceId))
// The looks the person chose for their Agents, read once for every portrait.
watch(activeSpaceId, id => void loadAgentLooks(id), { immediate: true })
// The person's own picture, for every 「我」 (person-home/MeAvatar.vue).
watch(activeSpaceId, id => void loadPersonProfile(id), { immediate: true })
// The names the built-in roles go by now, for every label that names one.
watch(activeSpaceId, id => void loadRoleNames(id), { immediate: true })

// The waiting-requests tray in the top bar stays fresh while the page is visible.
// Its count is everything 待决策 lists (rec#96): the Agents' requests, the
// knowledge waiting for confirmation and Tonborg's questions.
const attention = useAgentAttention()
const review = useReviewList()
const waiting = computed(() => attention.total + review.total)
const inboxLabel = computed(() => waiting.value ? t('shell.attentionWaiting', { count: waiting.value }) : t('shell.sections.askedYou'))
watch(activeSpaceId, (id) => { attention.setSpace(id); review.setSpace(id) }, { immediate: true })
let attentionTimer: ReturnType<typeof setInterval> | undefined
let reviewTimer: ReturnType<typeof setInterval> | undefined
function refreshAttention() { if (document.visibilityState === 'visible' && !attention.loading && !attention.open) void attention.refresh() }
// The knowledge read is larger, so it refreshes less often; the 待决策 page refreshes it on open.
function refreshReview() { if (document.visibilityState === 'visible' && !review.loading) void review.refresh() }
// The top bar's one refresh reads the console again, the waiting requests (the whole
// queue while the inbox is open, so that page needs no refresh of its own) and the page in
// view (page-refresh.ts). The button shows its progress until every read has settled.
const refreshing = ref(false)
async function refreshConsole() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await Promise.allSettled([
      store.refresh(),
      attention.loading ? undefined : attention.refresh(),
      review.loading ? undefined : review.refresh(),
      reloadPage(),
    ])
  } finally { refreshing.value = false }
}
// A newer release is a dot at the version's top-right (Jevons 11-04: not on the mark);
// the version opens 设置 › 系统 › 版本与更新, where it installs.
const latestVersion = ref<string | null>(null)
const versionRequest = new AbortController()
onMounted(() => {
  measureScrollbarSize()
  void readVersionStatus(versionRequest.signal)
    .then((status) => { latestVersion.value = offersUpdate(status) ? status.latestVersion : null })
    // Version checks are advisory and never interrupt the console.
    .catch(() => {})
  if (store.runtimeStatus === 'idle') void store.refresh()
  attentionTimer = setInterval(refreshAttention, 30000)
  reviewTimer = setInterval(refreshReview, 300000)
  document.addEventListener('visibilitychange', refreshAttention)
})
onBeforeUnmount(() => {
  versionRequest.abort()
  clearInterval(attentionTimer)
  clearInterval(reviewTimer)
  document.removeEventListener('visibilitychange', refreshAttention)
  attention.setSpace('')
  review.setSpace('')
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
    <GrowingBackdrop :destination="destination?.key" />
    <header v-window-drag class="app-topbar">
      <div class="app-topbar-inner">
        <div class="app-brand">
          <BrandEasterEgg ref="brand" compact :label="brandLabel" @press="pressBrand" />
          <!-- The official FULI wordmark in every language (Jevons 11-03: the title bar always says FULI,
               never 复利, and switching languages leaves it alone), centred on the mark as in the
               brand lockup; the service dot sits on its middle. -->
          <span class="app-brand-word">
            <button type="button" class="app-wordmark-button" :aria-label="brandLabel" data-brand-home @click="pressBrand">
              <img class="app-wordmark" :src="fuliWordmarkUrl('en-US')" alt="FULI" draggable="false" data-wordmark />
            </button>
            <!-- The service dot says ready on its own; its words show only when the service is not ready. -->
            <span class="app-runtime" :class="{ 'is-ready': runtimeReady }" role="status"
              :title="t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline')" data-runtime>
              <span class="app-runtime-dot" aria-hidden="true" />
              <span class="app-runtime-text" :class="{ 'is-visible': !runtimeReady }">{{ t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline') }}</span>
            </span>
            <!-- The version beside the dot opens 设置 › 系统 › 版本与更新 (update channel and updates). -->
            <RouterLink class="app-version" to="/settings?tab=system#version" draggable="false" data-app-version
              :aria-label="latestVersion ? t('shell.versionUpdate', { version: FULI_VERSION, latest: latestVersion })
                : t('shell.versionLink', { version: FULI_VERSION })">v{{ FULI_VERSION }}<span
                v-if="latestVersion" class="app-version-dot" aria-hidden="true" data-update-dot /></RouterLink>
          </span>
        </div>
        <!-- Only a record's own name is shown; a destination is already named by the dock
             (or the settings button), so its heading stays for screen readers only. -->
        <h1 v-if="!titleInPage" class="app-title" :class="{ 'is-screen-reader-only': !recordTitle }" :title="recordTitle || undefined">{{ title }}</h1>
        <SectionTabs :sections="sectionTabs" :active-key="section?.key" />
        <div class="app-actions">
          <!-- First, so the buttons after it stay put when it appears. -->
          <OpenInAppButton />
          <DoctorBanner />
          <!-- The page's own 「?」 keeps its place empty on pages without one, so the buttons never move. -->
          <span class="app-help-slot"><AiHelpButton v-if="route.meta.aiHelp" :term="route.meta.aiHelp" size="md" /></span>
          <GlossaryToggle />
          <UiIconButton icon="refresh" :label="t('shell.refreshPage')" :loading="refreshing" :loading-label="t('shell.refreshingPage')"
            :disabled="!refreshing && store.runtimeStatus === 'loading'" data-shell-refresh @click="refreshConsole" />
          <!-- 待决策 is a tray: empty when nothing waits, heaped with rice when something does. -->
          <!-- Hover shows what waits (InboxPeek), not a native tooltip. -->
          <HeaderPeek>
            <template #trigger>
              <RouterLink to="/inbox" class="app-round" :class="{ 'is-full': waiting, 'is-active': inboxActive }" :aria-current="inboxActive ? 'page' : undefined" :aria-label="inboxLabel"
                :data-attention="waiting ? 'full' : 'empty'" data-shell-inbox data-term="section.askedYou">
                <UiIcon :name="waiting ? 'trayFull' : 'tray'" :size="18" />
              </RouterLink>
            </template>
            <InboxPeek />
          </HeaderPeek>
          <ModelPowerButton />
          <RouterLink :to="settingsTo" class="app-round" :class="{ 'is-active': settingsActive, 'is-shaking': settingsHold.shaking.value }" :aria-current="settingsActive ? 'page' : undefined"
            draggable="false" v-bind="settingsHold.handlers"
            :aria-label="settingsLabel" :title="settingsLabel" data-destination="settings" data-term="destination.settings">
            <UiIcon name="settings" :size="18" />
            <span v-if="clientsNeedUpdate" class="app-round-dot" aria-hidden="true" data-clients-update-dot />
          </RouterLink>
        </div>
      </div>
    </header>
    <main class="app-main">
      <NavigationRecovery />
      <FeedbackToast />
      <CornerNotices />
      <RouterView v-slot="{ Component }"><component :is="Component" /></RouterView>
      <GlossaryLayer />
      <CaptureOnboardingDialog />
      <!-- After the first-run dialog closes, never with it (OnboardingTour.vue). -->
      <OnboardingTour />
    </main>
    <WidgetSlot place="shell.aboveDock" />
    <AppDock :destinations="dockDestinations" :active-key="destination?.key" :live-key="liveDockKey" :space-id="activeSpaceId" :folded="dockFolded" />
  </div>
  </MotionConfig>
</template>

<style scoped>
/* The page root (.view) is the scroll container: body never scrolls, so the
   main column keeps a fixed height and lets the routed page take the rest.
   The page itself is plain: surfaces and type carry the design (direction A). */
/* clip, not hidden: a hidden box can still be scrolled by scrollIntoView or focus, which pushed the top bar
   out of the window (Jevons 11-02: 用着用着头部不见了). A clipped box never scrolls. */
.app-frame { position: relative; isolation: isolate; display: flex; flex-direction: column; height: 100dvh; overflow: clip; color: var(--color-ink); background: var(--color-bg); }
.app-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: clip; }
/* Every page keeps its last lines clear of the floating dock. A page that
   ends with another block after its .view (项目's history card) keeps that
   space below the block instead, so no gap opens in the middle of the page. */
.app-main :deep(.view) { padding-bottom: var(--dock-clearance); }
.app-main :deep(.view:not(:last-child)) { padding-bottom: 0; }
/* The top bar is its own layer above the page, so what it opens (the doctor's panel) floats over the page's cards instead of under them. */
/* Every page has the workbench's width (tokens.css --page-inline); the top bar and the feedback line keep the
   page's edges, adding the room the page's scrollbar takes on the right. */
.app-topbar { position: relative; z-index: var(--z-popover); flex: 0 0 auto; padding: 12px calc(var(--page-inline) + var(--scrollbar-size)) 8px var(--page-inline); }
/* The bar is always the dock's frosted glass, never bare: bare, it looked solid where
   the drifting backdrop was empty and clear where a glow passed under it (Jevons 11-03:
   有时候透明有时候不透明). The glass lives on its own layer, as the dock's does, so the bar
   stays no backdrop root or containing block for what it opens. */
.app-topbar::before {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
  box-shadow: 0 1px 0 var(--edge-dock);
}
/* In the desktop client the bar is the window's title bar: the window's own controls (Windows'
   minimise, maximise and close, macOS's traffic lights) take a strip along its top and the bar's
   row sits below them; the strip is the bar's empty area, so it moves the window (lib/desktop-client.ts). */
:root[data-desktop-client] .app-topbar { padding-top: calc(12px + var(--desktop-caption-top, 0px)); }
.app-topbar-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; min-height: 44px; }
.app-brand { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.app-wordmark-button { display: inline-flex; padding: 0; border: 0; background: none; cursor: pointer; user-select: none; }
.app-wordmark-button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* The brand lockup's proportions (brand/svg/lockup): the wordmark's glyphs stand at about 0.54 of the
   mark's art (21px for the 38px mark; the files keep 16 of 232 units of clear space around the glyphs)
   and start about a quarter of the art to its right. The status dot and its words sit on the wordmark's
   vertical middle (Jevons 11-02: centred, not on the baseline). The row keeps the wordmark's height,
   so the words never move the brand. */
.app-brand-word { --wordmark-height: 21px; display: inline-flex; align-items: center; gap: 8px; height: var(--wordmark-height); margin-left: -3px; }
.app-wordmark { display: block; width: auto; height: var(--wordmark-height); user-select: none; -webkit-user-drag: none; }
.app-runtime { display: inline-flex; align-items: center; gap: 6px; --runtime: var(--status-error); }
.app-runtime.is-ready { --runtime: var(--color-success); }
.app-version {
  position: relative; color: var(--color-muted); font-size: var(--text-meta); font-variant-numeric: tabular-nums; text-decoration: none;
  user-select: none; border-radius: var(--radius-control, 6px);
}
.app-version:hover, .app-version:focus-visible { color: var(--color-ink); }
/* Over the corner, not beside the text: the version never moves when it appears. */
.app-version-dot {
  position: absolute; top: -2px; right: -6px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-danger); box-shadow: 0 1px 4px color-mix(in srgb, var(--color-danger) 28%, transparent);
}
/* The same dot on a round button's corner: an overlay, so the button never moves. */
.app-round-dot {
  position: absolute; top: 5px; right: 5px; width: 7px; height: 7px; border-radius: 50%; pointer-events: none;
  background: var(--color-danger); box-shadow: 0 0 0 2px var(--color-bg), 0 1px 4px color-mix(in srgb, var(--color-danger) 28%, transparent);
}
.app-runtime-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--runtime); }
.app-runtime-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.app-runtime-text.is-visible { position: static; width: auto; height: auto; overflow: visible; clip-path: none; color: var(--runtime); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.app-title { min-width: 0; margin: 0; font-size: var(--text-section); font-weight: var(--weight-strong); line-height: var(--leading-title); letter-spacing: -.02em; overflow-wrap: anywhere; }
.app-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
/* Quiet round buttons for the top-right destinations; only the current one is ink. */
.app-round {
  position: relative; display: grid; width: 36px; height: 36px; place-items: center; border-radius: 50%;
  color: var(--color-ink-soft); background: transparent; text-decoration: none; isolation: isolate;
  transition: color var(--motion-fast), background var(--motion-fast);
}
.app-round:hover { color: var(--color-ink); background: var(--color-surface-hover); }
/* The current page (Jevons 11-06: not a solid black disc): two quick strokes of honey crayon
   scribbled under the ink icon, rough-edged and grainy like wax on paper, inside the button.
   They are drawn on like a hand would: the first stroke left to right, then the crayon comes
   back right to left for the second. */
.app-round.is-active, .app-round.is-active:hover { color: var(--color-ink); background: transparent; }
.app-round.is-active::before, .app-round.is-active::after {
  content: ''; position: absolute; inset: 3px; z-index: -1; pointer-events: none;
  background: var(--color-scribble);
  -webkit-mask: var(--scribble-stroke) center / contain no-repeat;
  mask: var(--scribble-stroke) center / contain no-repeat;
}
.app-round.is-active::before {
  --scribble-stroke: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Cfilter id='c' x='-20%25' y='-20%25' width='140%25' height='140%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.15' numOctaves='2' seed='4' result='n'/%3E%3CfeDisplacementMap in='SourceGraphic' in2='n' scale='2.4' result='d'/%3E%3CfeColorMatrix in='n' type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.6 1.85' result='g'/%3E%3CfeComposite in='d' in2='g' operator='in'/%3E%3C/filter%3E%3Cpath filter='url(%23c)' d='M8 20.5C13 15 19 12 27.5 9.5' fill='none' stroke='%23000' stroke-width='4.4' stroke-linecap='round'/%3E%3C/svg%3E");
  animation: app-round-scribble-across 200ms cubic-bezier(.4, 0, .6, 1) both;
}
.app-round.is-active::after {
  --scribble-stroke: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Cfilter id='c' x='-20%25' y='-20%25' width='140%25' height='140%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.15' numOctaves='2' seed='4' result='n'/%3E%3CfeDisplacementMap in='SourceGraphic' in2='n' scale='2.4' result='d'/%3E%3CfeColorMatrix in='n' type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.6 1.85' result='g'/%3E%3CfeComposite in='d' in2='g' operator='in'/%3E%3C/filter%3E%3Cpath filter='url(%23c)' d='M9 28.5C14.5 23 21 20 29 18' fill='none' stroke='%23000' stroke-width='4.4' stroke-linecap='round'/%3E%3C/svg%3E");
  animation: app-round-scribble-back 220ms cubic-bezier(.4, 0, .6, 1) 160ms both;
}
@keyframes app-round-scribble-across { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0); } }
@keyframes app-round-scribble-back { from { clip-path: inset(0 0 0 100%); } to { clip-path: inset(0); } }
/* A full tray reads in ink on a filled disc (Jevons 11-06), and every twelve seconds it gives a
   short wiggle so waiting decisions are noticed; its papers drop in when it fills (reduced
   motion zeroes this in primitives.css). */
/* The heaped tray is filling enough on its own (Jevons 11-06: a resting disc looked like a stuck hover). */
.app-round.is-full { color: var(--color-ink); animation: app-round-nudge 12s ease-in-out 3s infinite; }
/* The full tray (Jevons 11-06): a heaped bowl of white rice spilling over a solid tray, dotted
   with coloured grains. */
.app-round.is-full :deep(.tray-rice-mound), .app-round.is-full :deep(.tray-rice-spill) { fill: var(--color-surface); stroke-width: 1.3; }
.app-round.is-full :deep(.tray-front) { fill: currentColor; }
.app-round.is-full :deep(.tray-slot) { stroke: var(--color-surface); stroke-width: 1.5; }
.app-round.is-full :deep(.tray-grain) { stroke: none; }
.app-round.is-full :deep(.tray-grain--1) { fill: var(--color-power-mid); }
.app-round.is-full :deep(.tray-grain--2) { fill: var(--color-glitch-cyan); }
.app-round.is-full :deep(.tray-grain--3) { fill: var(--color-gold); }
.app-round.is-full :deep(.tray-grain--4) { fill: var(--color-glitch-magenta); }
.app-round.is-full :deep(.tray-grain--5) { fill: var(--color-success); }
@keyframes app-round-nudge {
  0%, 6%, 100% { transform: rotate(0); }
  1% { transform: rotate(-12deg); } 2% { transform: rotate(10deg); } 3% { transform: rotate(-7deg); }
  4% { transform: rotate(4deg); } 5% { transform: rotate(-2deg); }
}
.app-round.is-shaking { animation: app-round-shake 120ms linear infinite; }
@keyframes app-round-shake { 0%, 100% { transform: rotate(0); } 25% { transform: rotate(-7deg); } 75% { transform: rotate(7deg); } }
.app-round :deep(.tray-rice) { transform-box: fill-box; animation: tray-rice-in var(--motion-enter); }
@keyframes tray-rice-in { from { opacity: 0; transform: translateY(-5px); } }
/* A record's name in the bar is a section-size line; a long one ends in … and its full text is the tooltip. */
.app-title.is-screen-reader-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.app-title:not(.is-screen-reader-only) { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
@media (min-width: 721px) {
  .app-topbar-inner { flex-wrap: nowrap; }
  .app-title { flex: 0 1 auto; min-width: 0; }
  .app-topbar-inner :is(.section-tabs, .app-actions, .app-brand) { flex-shrink: 0; }
}
@media (max-width: 720px) {
  .app-topbar-inner { min-height: 36px; }
  .app-wordmark { display: none; }
  /* Brand, title and actions share the first row; the section tabs take their own. */
  .app-topbar-inner > .section-tabs { order: 3; flex-basis: 100%; }
}
@media (prefers-reduced-motion: reduce) { .app-round { transition: none; } .app-round.is-shaking, .app-round.is-full { animation: none; } }
:root[data-motion="reduced"] .app-round.is-shaking, :root[data-motion="reduced"] .app-round.is-full { animation: none; }
:root[data-motion="reduced"] .app-round { transition: none; }
.app-help-slot { display: inline-flex; width: var(--control-height-md); justify-content: center; }
.app-help-slot :deep(.ai-help-button) { margin: 0; }
</style>
