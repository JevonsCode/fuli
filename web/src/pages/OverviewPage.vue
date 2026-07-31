<script setup lang="ts">
import { computed } from 'vue'

import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

const store = useConsoleStore()
const state = computed(() => store.state)
const workspaceProviders = computed(() => state.value?.providers?.workspaces ?? [])
const readyWorkspaces = computed(
  () => workspaceProviders.value.filter(({ status }) => status === 'ready').length,
)
</script>

<template>
  <section class="view">
    <div class="intro-row">
      <div>
        <h3>{{ t('pages.overview.introTitle') }}</h3>
        <p>{{ t('pages.overview.introCopy') }}</p>
      </div>
      <span class="mode-chip">Agent structured</span>
    </div>

    <div class="metrics" :aria-label="t('pages.overview.metricsAria')">
      <article><strong>{{ state?.personalSpaces.length ?? 0 }}</strong><span>{{ t('pages.overview.personalGraphs') }}</span></article>
      <article><strong>{{ state?.projects.length ?? 0 }}</strong><span>{{ t('pages.overview.accessibleProjects') }}</span></article>
      <article><strong>{{ state?.subscriptions.length ?? 0 }}</strong><span>{{ t('pages.overview.subscriptions') }}</span></article>
      <article><strong>{{ state?.personalProjects?.length ?? 0 }}</strong><span>{{ t('pages.overview.personalProjects') }}</span></article>
    </div>

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
        <div class="section-title"><h3>Provider</h3></div>
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
