<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, watch, watchEffect } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import { AGENT_PINS_KEY, useAgentPins } from '@/features/agent-profile/agent-pins'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { t } from '@/i18n'
import { routeMetaText, updateDocumentTitle } from '@/router/meta'
import { useConsoleStore } from '@/stores/console'
import { UiButton, UiIconButton } from '@/ui'
import NavRail from './NavRail.vue'
import SectionTabs from './SectionTabs.vue'
import { activeDestination, activeSection, navDestinations } from './nav-destinations'

// The console frame: icon rail (bottom bar on narrow screens), a top bar with
// the page title and the active destination's sections, and the routed page.
const store = useConsoleStore()
const route = useRoute()
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const destinations = computed(() => navDestinations({
  spaceId: activeSpaceId.value || 'current',
  publicProjects: store.state?.capabilities?.browsePublicProjects !== false,
  review: store.state?.capabilities?.submitKnowledge !== false || store.state?.capabilities?.reviewProposals === true,
}))
const destination = computed(() => activeDestination(destinations.value, route.path))
const section = computed(() => activeSection(destination.value, route.path))
const title = computed(() => routeMetaText(route.meta.title, 'routes.overview.title'))
const dedicatedWorkspace = computed(() => route.meta.dedicatedWorkspace === true)

// Pins stay a feature of Agent cards and profiles even without a sidebar list.
provide(AGENT_PINS_KEY, useAgentPins(activeSpaceId))

// The 对话 badge keeps the waiting count fresh while the page is visible.
const attention = useAgentAttention()
watch(activeSpaceId, id => attention.setSpace(id), { immediate: true })
let attentionTimer: ReturnType<typeof setInterval> | undefined
function refreshAttention() { if (document.visibilityState === 'visible' && !attention.loading && !attention.open) void attention.refresh() }
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
watchEffect(() => updateDocumentTitle(route.meta.title))
</script>

<template>
  <div class="app-frame">
    <NavRail :destinations="destinations" :active-key="destination?.key" :attention-count="attention.total"
      :runtime-ready="store.runtimeStatus === 'ready'" />
    <main class="app-main">
      <header v-if="!dedicatedWorkspace" class="app-topbar">
        <h1 class="app-title">{{ title }}</h1>
        <SectionTabs :sections="destination?.sections ?? []" :active-key="section?.key" />
        <div class="app-actions">
          <template v-if="route.name === 'settings'">
            <GrowthLoading v-if="store.settingsSaving" variant="inline" :label="t(store.settingsSaveState === 'applying' ? 'settings.applying' : 'settings.saving')" />
            <UiButton variant="primary" :disabled="store.settingsSaving" form="settings-form" type="submit">{{ t(store.settingsSaveState === 'saved' ? 'settings.savedShort' : 'settings.save') }}</UiButton>
          </template>
          <LocaleSwitcher />
          <UiIconButton icon="refresh" :label="t('common.actions.refresh')" :disabled="store.runtimeStatus === 'loading'" @click="store.refresh" />
        </div>
      </header>
      <NavigationRecovery />
      <div v-if="store.feedback" class="feedback feedback-message" :class="{ success: store.feedback.tone === 'success' }"
        :role="store.feedback.tone === 'error' ? 'alert' : 'status'" :aria-live="store.feedback.tone === 'error' ? 'assertive' : 'polite'">
        <span>{{ store.feedback.message }}</span>
        <UiIconButton icon="close" size="sm" :label="t('common.actions.close')" @click="store.clearFeedback" />
      </div>
      <RouterView v-slot="{ Component }"><component :is="Component" /></RouterView>
    </main>
  </div>
</template>

<style scoped>
/* The page root (.view) is the scroll container: body never scrolls, so the
   main column keeps a fixed height and lets the routed page take the rest. */
.app-frame { display: flex; height: 100dvh; overflow: hidden; background: var(--color-bg); color: var(--color-ink); }
.app-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.app-topbar { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 12px 20px; min-height: 64px; padding: 10px var(--page-gutter); }
.app-title { margin: 0; font-size: var(--text-title); font-weight: 700; letter-spacing: -.01em; }
.app-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.feedback-message { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; margin: 0 var(--page-gutter) 8px; }
@media (max-width: 720px) {
  .app-main { padding-bottom: calc(60px + env(safe-area-inset-bottom)); }
  .app-topbar { min-height: 56px; }
  .app-title { font-size: 19px; }
  /* Title and actions share the first row; the section tabs take their own. */
  .app-topbar > .section-tabs { order: 3; flex-basis: 100%; }
}
</style>
