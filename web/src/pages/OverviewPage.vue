<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import { t } from '@/i18n'
import { knowledgePath, personalProjectsPath } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'

const store = useConsoleStore()
const state = computed(() => store.state)
const activePersonalSpace = computed(() => store.activePersonalSpace)
const activeSpaceId = computed(
  () => activePersonalSpace.value?.id ?? state.value?.activePersonalSpaceId ?? 'current',
)
const personalKnowledgeTo = computed(
  () => knowledgePath('personal', activeSpaceId.value, 'directory'),
)
const personalProjectsTo = computed(
  () => personalProjectsPath(activeSpaceId.value, 'graph'),
)
const workspaceProviders = computed(() => state.value?.providers?.workspaces ?? [])
const readyWorkspaces = computed(
  () => workspaceProviders.value.filter(({ status }) => status === 'ready').length,
)
const sharedProjectsTo = computed(
  () => store.publicRuntimeStatus === 'ready' ? '/public-projects' : '/connections',
)
const personalSpaceStatus = computed(() => {
  if (store.runtimeStatus === 'error') return t('pages.overview.personalSpaceUnavailable')
  if (store.runtimeStatus !== 'ready') return t('pages.overview.personalSpaceLoading')
  return t('pages.overview.personalSpaceLocal')
})
const sharedProjectsValue = computed(() => {
  if (store.publicRuntimeStatus === 'error') return t('pages.overview.publicUnavailable')
  if (store.publicRuntimeStatus !== 'ready') return t('pages.overview.publicDisconnected')
  return String(state.value?.projects.length ?? 0)
})
const sharedProjectsCopy = computed(() => {
  if (store.publicRuntimeStatus === 'error') return t('pages.overview.publicUnavailableCopy')
  if (store.publicRuntimeStatus !== 'ready') return t('pages.overview.publicDisconnectedCopy')
  if ((state.value?.projects.length ?? 0) === 0) return t('pages.overview.noSharedProjects')
  return t('pages.overview.sharedSubscriptions', {
    count: state.value?.subscriptions.length ?? 0,
  })
})
const sharedProjectsAction = computed(() => {
  if (store.publicRuntimeStatus === 'error') return t('pages.overview.checkConnection')
  if (store.publicRuntimeStatus !== 'ready') return t('pages.overview.connectPublic')
  return t('pages.overview.browseSharedProjects')
})
</script>

<template>
  <section class="view overview-view">
    <nav class="overview-summary" :aria-label="t('pages.overview.metricsAria')">
      <RouterLink class="overview-summary-card overview-space-card" :to="personalKnowledgeTo">
        <span class="overview-summary-label">{{ t('pages.overview.currentPersonalSpace') }}</span>
        <strong class="overview-summary-name">
          {{ activePersonalSpace?.name ?? t('pages.overview.personalSpaceFallback') }}
        </strong>
        <span class="overview-summary-meta">
          <i
            class="overview-status-dot"
            :class="store.runtimeStatus === 'ready' ? 'ready' : store.runtimeStatus"
            aria-hidden="true"
          />
          {{ personalSpaceStatus }}
        </span>
        <span class="overview-summary-action">
          {{ t('pages.overview.openKnowledge') }}
          <span aria-hidden="true">→</span>
        </span>
      </RouterLink>

      <RouterLink class="overview-summary-card overview-personal-projects-card" :to="personalProjectsTo">
        <span class="overview-summary-label">{{ t('pages.overview.personalProjects') }}</span>
        <strong class="overview-summary-value">{{ state?.personalProjects?.length ?? 0 }}</strong>
        <span class="overview-summary-meta">{{ t('pages.overview.personalProjectsCopy') }}</span>
        <span class="overview-summary-action">
          {{ t('pages.overview.viewPersonalProjects') }}
          <span aria-hidden="true">→</span>
        </span>
      </RouterLink>

      <RouterLink
        class="overview-summary-card overview-shared-projects-card"
        :class="`is-${store.publicRuntimeStatus}`"
        :to="sharedProjectsTo"
      >
        <span class="overview-summary-label">{{ t('pages.overview.sharedProjects') }}</span>
        <strong class="overview-summary-value overview-shared-value">{{ sharedProjectsValue }}</strong>
        <span class="overview-summary-meta">{{ sharedProjectsCopy }}</span>
        <span class="overview-summary-action">
          {{ sharedProjectsAction }}
          <span aria-hidden="true">→</span>
        </span>
      </RouterLink>
    </nav>

    <div class="two-column">
      <section class="section-block">
        <div class="section-title"><h3>{{ t('pages.overview.dataFlow') }}</h3></div>
        <ol class="flow-list">
          <li><span>1</span><div><strong>{{ t('pages.overview.flow.identifyTitle') }}</strong><p>{{ t('pages.overview.flow.identifyCopy') }}</p></div></li>
          <li><span>2</span><div><strong>{{ t('pages.overview.flow.structureTitle') }}</strong><p>{{ t('pages.overview.flow.structureCopy') }}</p></div></li>
          <li><span>3</span><div><strong>{{ t('pages.overview.flow.routeTitle') }}</strong><p>{{ t('pages.overview.flow.routeCopy') }}</p></div></li>
        </ol>
      </section>
      <section class="section-block">
        <div class="section-title"><h3>{{ t('pages.overview.serviceStatus') }}</h3></div>
        <div class="provider-list">
          <div class="provider-row">
            <i :class="{ error: state?.providers?.personal?.status !== 'ready' }" />
            <div><strong>{{ t('pages.overview.localKnowledge') }}</strong><span>Graphiti / Neo4j</span></div>
            <span class="provider-state">
              {{ state?.providers?.personal?.status === 'ready' ? t('common.status.connected') : t('common.status.connectionError') }}
            </span>
          </div>
          <div class="provider-row">
            <i :class="store.publicRuntimeStatus" />
            <div>
              <strong>{{ t('pages.overview.publicService') }}</strong>
              <span>
                {{ store.publicRuntimeStatus === 'ready'
                  ? t('pages.overview.sharedServicesReady', { count: readyWorkspaces || workspaceProviders.length })
                  : store.publicRuntimeStatus === 'error' ? t('pages.overview.publicTemporarilyUnavailable') : t('pages.overview.publicOfflineLocalUnaffected') }}
              </span>
            </div>
            <span class="provider-state">
              {{ store.publicRuntimeStatus === 'ready' ? t('common.status.connected')
                : store.publicRuntimeStatus === 'error' ? t('common.status.connectionError') : t('common.status.notConnected') }}
            </span>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
