<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, watchEffect } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import BrandEasterEgg from '@/components/BrandEasterEgg.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import EmployeeNavigation from '@/features/employees/EmployeeNavigation.vue'
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
const eyebrow = computed(() => String(route.meta.eyebrow ?? 'LOCAL + FEDERATED'))
const description = computed(() => routeMetaText(route.meta.description))
const dedicatedWorkspace = computed(() => route.meta.dedicatedWorkspace === true)
const publicReady = computed(() => store.publicRuntimeStatus === 'ready')
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
})

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
          <span class="nav-copy"><strong>{{ t('console.navigation.preferences') }}</strong><small>{{ t('console.navigation.preferencesMeta') }}</small></span>
        </RouterLink>
        <RouterLink class="space-nav-button knowledge-organizer-button" to="/organize" active-class="is-active">
          <span class="nav-icon nav-icon-knowledge-organizer" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ t('console.navigation.organizer') }}</strong><small>{{ t('console.navigation.organizerMeta') }}</small></span>
        </RouterLink>
        <RouterLink class="space-nav-button personal-space-button" :to="personalProjectsTo" active-class="is-active">
          <span class="nav-icon nav-icon-personal-project" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ t('console.navigation.personalProjects') }}</strong><small>{{ t('console.navigation.personalProjectsMeta') }}</small></span>
        </RouterLink>
        <RouterLink class="space-nav-button project-agents-button" to="/project-agents" active-class="is-active">
          <span class="nav-icon nav-icon-project-agent" aria-hidden="true" />
          <span class="nav-copy"><strong>{{ t('console.navigation.projectAgents') }}</strong><small>{{ t('console.navigation.projectAgentsMeta') }}</small></span>
        </RouterLink>

        <template v-if="publicVisible">
          <p class="nav-section-label nav-public-label">{{ t('console.navigation.publicSpace') }}</p>
          <RouterLink class="space-nav-button public-space-button" to="/public-projects" active-class="is-active">
            <span class="nav-icon nav-icon-public-project" aria-hidden="true" />
            <span class="nav-copy"><strong>{{ t('console.navigation.publicProjects') }}</strong><small>{{ t('console.navigation.publicProjectsMeta') }}</small></span>
          </RouterLink>
        </template>

        <EmployeeNavigation :personal-space-id="activeSpaceId" />

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
              <small>Graphiti / Neo4j</small>
            </div>
          </div>
          <div class="runtime-status">
            <span class="status-dot" :class="store.publicRuntimeStatus" />
            <div>
              <strong>{{ publicRuntimeLabel }}</strong>
              <small>{{ publicRuntimeCopy }}</small>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar" :class="{ 'topbar--workbench': dedicatedWorkspace }">
        <button
          ref="mobileNavToggleRef"
          class="mobile-nav-toggle quiet-button"
          type="button"
          aria-controls="console-primary-sidebar"
          :aria-expanded="mobileNavOpen"
          @click="openMobileNav"
        >
          <span class="mobile-nav-icon" aria-hidden="true" />
          {{ t('console.navigation.openMenu') }}
        </button>
        <span v-if="dedicatedWorkspace" class="workbench-host-label">FULI</span>
        <div v-else class="topbar-heading">
          <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
          <h2>{{ title }}</h2>
          <p v-if="description" class="topbar-description">{{ description }}</p>
        </div>
        <div v-if="!dedicatedWorkspace" class="topbar-actions">
          <span v-if="publicReady" class="mode-chip">{{ t('console.publicReady') }}</span>
          <button
            v-if="route.name === 'settings'"
            class="settings-save-button"
            form="settings-form"
            type="submit"
          >
            {{ t('settings.save') }}
          </button>
          <LocaleSwitcher />
          <button class="quiet-button" type="button" @click="store.refresh">{{ t('common.actions.refresh') }}</button>
        </div>
      </header>

      <NavigationRecovery />

      <button
        v-if="store.feedback"
        class="feedback feedback-button"
        :class="{ success: store.feedback.tone === 'success' }"
        type="button"
        aria-live="polite"
        @click="store.clearFeedback"
      >
        {{ store.feedback.message }}
      </button>

      <RouterView v-slot="{ Component }">
        <component :is="Component" />
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.topbar--workbench { display: none; }
.workbench-host-label { color: #58675d; font-size: 12px; font-weight: 600; }
@media (max-width: 920px) {
  .topbar--workbench { display: flex; justify-content: flex-start; gap: 12px; min-height: 44px; padding: 7px 16px; border: 0; background: #fff; }
}
</style>
