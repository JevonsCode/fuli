<script setup lang="ts">
import UiButton from '@/components/UiButton.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import BrandEasterEgg from '@/components/BrandEasterEgg.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import EmployeeNavigation from '@/features/employees/EmployeeNavigation.vue'
import { copy as roundtableCopy } from '@/features/roundtables/copy'
import AgentAttentionCenter from '@/features/project-agents/AgentAttentionCenter.vue'
import { t } from '@/i18n'
import { routeMetaText, updateDocumentTitle } from '@/router/meta'
import { personalProjectsPath, knowledgePath } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'

const store = useConsoleStore()
const route = useRoute()
const mobileNavOpen = ref(false)
const mobileNavToggleRef = ref<HTMLButtonElement | null>(null)
const mobileNavCloseRef = ref<HTMLButtonElement | null>(null)

const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? 'current')
const personalProjectsTo = computed(() => personalProjectsPath(activeSpaceId.value, 'graph'))
const knowledgeTo = computed(() => knowledgePath('personal', activeSpaceId.value, 'directory'))
const title = computed(() => routeMetaText(route.meta.title, 'routes.overview.title'))
const dedicatedWorkspace = computed(() => route.meta.dedicatedWorkspace === true)
const publicRuntimeLabel = computed(() => {
  if (store.publicRuntimeStatus === 'ready') return t('console.services.publicReady')
  if (store.publicRuntimeStatus === 'error') return t('console.services.publicError')
  return t('console.services.publicOffline')
})
const publicRuntimeCopy = computed(() => {
  if (store.publicRuntimeStatus === 'ready') {
    const capabilities = store.state?.capabilities
    if (capabilities?.browsePublicProjects && capabilities?.subscribeProject
        && !capabilities?.publishProject && !capabilities?.submitKnowledge
        && !capabilities?.reviewProposals) {
      return t('console.services.publicBrowseSubscribe')
    }
    return t('console.services.publicAvailable')
  }
  if (store.publicRuntimeStatus === 'error') return t('console.services.localUnaffected')
  return t('console.services.localOnly')
})
const publicVisible = computed(() => store.state?.capabilities?.browsePublicProjects !== false)
const reviewVisible = computed(() => {
  const capabilities = store.state?.capabilities
  return capabilities?.submitKnowledge !== false || capabilities?.reviewProposals === true
})

onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
function onResize() { if (window.innerWidth > 920) mobileNavOpen.value = false }
function containMobileFocus(event: KeyboardEvent) {
  if (!mobileNavOpen.value || event.key !== 'Tab') return
  const controls = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')]
    .filter((element) => element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

watchEffect(() => {
  updateDocumentTitle(route.meta.title)
})

watch(() => route.fullPath, () => {
  mobileNavOpen.value = false
})

async function openMobileNav() {
  mobileNavOpen.value = true
  await nextTick()
  mobileNavCloseRef.value?.focus({ preventScroll: true })
}

async function closeMobileNav() {
  mobileNavOpen.value = false
  await nextTick()
  mobileNavToggleRef.value?.focus({ preventScroll: true })
}

</script>

<template>
  <div class="app-shell">
    <aside
      id="console-primary-sidebar"
      class="sidebar"
      :class="{ 'is-mobile-open': mobileNavOpen }"
      @keydown.esc.stop="closeMobileNav"
      @keydown="containMobileFocus"
    >
      <button
        ref="mobileNavCloseRef"
        class="mobile-nav-close quiet-button"
        type="button"
        @click="closeMobileNav"
      >
        {{ t('console.navigation.closeMenu') }}
      </button>
      <BrandEasterEgg />

      <nav class="primary-nav" :aria-label="t('console.navigation.aria')">
        <p class="nav-section-label">{{ t('console.navigation.workspace') }}</p>
        <RouterLink to="/" exact-active-class="is-active">
          <span class="nav-icon nav-icon-overview" aria-hidden="true" />
          <span class="nav-label">{{ t('console.navigation.overview') }}</span>
        </RouterLink>

        <p class="nav-section-label nav-space-label">{{ t('console.navigation.personalSpace') }}</p>
        <RouterLink class="space-nav-button personal-profile-button" to="/preferences" active-class="is-active">
          <span class="nav-icon nav-icon-personal-profile" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ t('console.navigation.preferences') }}</strong></span>
        </RouterLink>
        <RouterLink class="space-nav-button knowledge-organizer-button" to="/organize" active-class="is-active">
          <span class="nav-icon nav-icon-knowledge-organizer" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ t('console.navigation.organizer') }}</strong></span>
        </RouterLink>
        <RouterLink class="space-nav-button personal-space-button" :to="personalProjectsTo" active-class="is-active">
          <span class="nav-icon nav-icon-personal-project" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ t('console.navigation.personalProjects') }}</strong></span>
        </RouterLink>
        <RouterLink class="space-nav-button project-agents-button" to="/project-agents" active-class="is-active">
          <span class="nav-icon nav-icon-project-agent" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ t('console.navigation.projectAgents') }}</strong></span>
        </RouterLink>
        <RouterLink class="space-nav-button roundtables-button" to="/roundtables" active-class="is-active">
          <span class="nav-icon nav-icon-project-agent" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ roundtableCopy('Agent 圆桌', 'Agent Roundtable') }}</strong><small>{{ roundtableCopy('讨论 · 分工 · 结果', 'Discuss · assign · deliver') }}</small></span>
        </RouterLink>

        <template v-if="publicVisible">
          <p class="nav-section-label nav-public-label">{{ t('console.navigation.publicSpace') }}</p>
          <RouterLink class="space-nav-button public-space-button" to="/public-projects" active-class="is-active">
            <span class="nav-icon nav-icon-public-project" aria-hidden="true" />
            <span class="nav-copy"><strong>{{ t('console.navigation.publicProjects') }}</strong></span>
          </RouterLink>
        </template>

        <EmployeeNavigation :personal-space-id="activeSpaceId" />
        <AgentAttentionCenter :personal-space-id="activeSpaceId" :projects="store.state?.personalProjects ?? []" />

        <p class="nav-section-label nav-tool-label">{{ t('console.navigation.governance') }}</p>
        <RouterLink :to="knowledgeTo" active-class="is-active">
          <span class="nav-icon nav-icon-knowledge-graph" aria-hidden="true" />
          <span class="nav-label">{{ t('console.navigation.knowledge') }}</span>
        </RouterLink>
        <RouterLink v-if="reviewVisible" to="/review" active-class="is-active">
          <span class="nav-icon nav-icon-review" aria-hidden="true" />
          <span class="nav-label">{{ t('console.navigation.review') }}</span>
        </RouterLink>
        <RouterLink to="/connections" active-class="is-active">
          <span class="nav-icon nav-icon-connections" aria-hidden="true" />
          <span class="nav-label">{{ t('console.navigation.connections') }}</span>
        </RouterLink>

        <p class="nav-section-label nav-about-label">{{ t('console.navigation.aboutSection') }}</p>
        <RouterLink to="/settings" active-class="is-active">
          <span class="nav-icon nav-icon-settings" aria-hidden="true" />
          <span class="nav-label">{{ t('console.navigation.settings') }}</span>
        </RouterLink>
        <RouterLink to="/about" active-class="is-active">
          <span class="nav-icon nav-icon-about" aria-hidden="true" />
          <span class="nav-label">{{ t('console.navigation.about') }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <div class="service-runtime-list" :aria-label="t('console.services.aria')">
          <div class="runtime-status">
            <span class="status-dot" :class="store.runtimeStatus" />
            <div>
              <strong>
                {{ store.runtimeStatus === 'ready' ? t('console.services.localReady')
                  : store.runtimeStatus === 'error' ? t('console.services.localError')
                    : t('console.services.localConnecting') }}
              </strong>

            </div>
          </div>
          <details class="service-details">
            <summary><span class="status-dot" :class="store.publicRuntimeStatus" />{{ publicRuntimeLabel }}</summary>
            <div class="runtime-status"><div><small>{{ publicRuntimeCopy }}</small><RouterLink to="/connections">{{ t('console.navigation.connections') }}</RouterLink></div></div>
          </details>
        </div>
      </div>
    </aside>

    <button v-if="mobileNavOpen" class="mobile-nav-backdrop" type="button" tabindex="-1" :aria-label="t('console.navigation.closeMenu')" @click="closeMobileNav" />
    <main class="workspace" :inert="mobileNavOpen || undefined">
      <header class="topbar" :class="{ 'topbar--workbench': dedicatedWorkspace }">
        <button
          ref="mobileNavToggleRef"
          class="mobile-nav-toggle quiet-button"
          type="button"
          aria-controls="console-primary-sidebar"
          :aria-expanded="mobileNavOpen"
          :aria-label="t('console.navigation.openMenu')"
          @click="openMobileNav"
        >
          <span class="mobile-nav-icon" aria-hidden="true" />
        </button>
        <span v-if="dedicatedWorkspace" class="workbench-host-label">FULI</span>
        <div v-else class="topbar-heading">
          <h1>{{ title }}</h1>
        </div>
        <div v-if="!dedicatedWorkspace" class="topbar-actions">
          <UiButton v-if="route.name === 'settings'" variant="primary" :disabled="store.settingsSaving" form="settings-form" type="submit">{{ t('settings.save') }}</UiButton>
          <LocaleSwitcher />
          <UiButton variant="ghost" icon :disabled="store.runtimeStatus === 'loading'" :aria-label="t('common.actions.refresh')" :title="t('common.actions.refresh')" @click="store.refresh">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .5 5M16 3v4h-4" /></svg>
          </UiButton>
        </div>
      </header>

      <NavigationRecovery />

      <div
        v-if="store.feedback"
        class="feedback feedback-message"
        :class="{ success: store.feedback.tone === 'success' }"
        role="status"
        aria-live="polite"
      >
        <span>{{ store.feedback.message }}</span>
        <button class="feedback-dismiss" type="button" :aria-label="t('common.actions.close')" @click="store.clearFeedback">×</button>
      </div>

      <RouterView v-slot="{ Component }">
        <component :is="Component" />
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.topbar--workbench { display: none; }
.workbench-host-label { color: var(--color-muted); font-size: 12px; font-weight: 600; }
@media (max-width: 920px) {
  .topbar--workbench { display: flex; justify-content: flex-start; gap: 12px; min-height: 44px; padding: 7px 16px; border: 0; background: var(--color-surface); }
}
</style>
