<script setup lang="ts">
import { computed, ref } from 'vue'

import { deleteJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { PublicProject, Subscription } from '@/types'

const store = useConsoleStore()
const selectedProjectKey = ref('')
const personalReady = computed(() => store.state?.providers?.personal?.status === 'ready')
const workspaces = computed(() => store.state?.providers?.workspaces ?? [])
const readyWorkspaces = computed(() => workspaces.value.filter(({ status }) => status === 'ready').length)
const subscriptions = computed(() => store.state?.subscriptions ?? [])
const subscribedKeys = computed(
  () => new Set(subscriptions.value.map(({ provider_url, project_id }) => `${provider_url}::${project_id}`)),
)
const availableProjects = computed(() =>
  (store.state?.projects ?? []).filter((project) => !subscribedKeys.value.has(projectKey(project))),
)
const availableProjectOptions = computed(() =>
  availableProjects.value.map((project) => ({
    value: projectKey(project),
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)

function projectKey(project: PublicProject) {
  return `${project.providerUrl}::${project.id}`
}

async function subscribe() {
  const project = availableProjects.value.find((item) => projectKey(item) === selectedProjectKey.value)
  if (!project) return
  try {
    await postJson('/api/subscriptions', {
      personalSpaceId: store.activePersonalSpace?.id,
      projectId: project.id,
      providerUrl: project.providerUrl,
      projectName: project.name,
    })
    selectedProjectKey.value = ''
    store.notify(t('pages.connections.subscribed', { name: project.name }))
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  }
}

async function unsubscribe(subscription: Subscription) {
  try {
    const query = new URLSearchParams({
      personalSpaceId: store.activePersonalSpace?.id ?? '',
      providerUrl: subscription.provider_url,
    })
    await deleteJson(`/api/subscriptions/${encodeURIComponent(subscription.project_id)}?${query}`)
    store.notify(t('pages.connections.unsubscribed', {
      name: subscription.project_name ?? subscription.project_id,
    }))
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  }
}
</script>

<template>
  <section class="view connections-view">
    <div class="connection-intro">
      <h3>{{ t('pages.connections.title') }}</h3>
      <p>{{ t('pages.connections.intro') }}</p>
    </div>
    <div class="service-connection-grid" :aria-label="t('pages.connections.statusAria')">
      <article class="service-connection-card" :data-status="personalReady ? 'ready' : 'error'">
        <header>
          <span class="service-connection-icon local" aria-hidden="true"><span class="nav-icon nav-icon-personal-project" /></span>
          <div><p>LOCAL KNOWLEDGE</p><h3>{{ t('pages.connections.localGraphiti') }}</h3></div>
          <span class="service-state">{{ personalReady ? t('common.status.connected') : t('common.status.connectionError') }}</span>
        </header>
        <p>{{ personalReady ? t('pages.connections.localReadyCopy') : t('pages.connections.localErrorCopy') }}</p>
        <dl><div><dt>{{ t('pages.connections.storage') }}</dt><dd>Neo4j</dd></div><div><dt>{{ t('pages.connections.purpose') }}</dt><dd>{{ t('pages.connections.localPurpose') }}</dd></div></dl>
      </article>

      <article class="service-connection-card" :data-status="store.publicRuntimeStatus">
        <header>
          <span class="service-connection-icon public" aria-hidden="true"><span class="nav-icon nav-icon-public-project" /></span>
          <div><p>PUBLIC PROVIDER</p><h3>{{ t('pages.connections.publicService') }}</h3></div>
          <span class="service-state">{{ store.publicRuntimeStatus === 'ready' ? t('common.status.connected') : store.publicRuntimeStatus === 'error' ? t('common.status.connectionError') : t('common.status.notConnected') }}</span>
        </header>
        <p>{{ store.publicRuntimeStatus === 'ready' ? t('pages.connections.publicReadyCopy') : store.publicRuntimeStatus === 'error' ? t('pages.connections.publicErrorCopy') : t('pages.connections.publicOfflineCopy') }}</p>
        <dl>
          <div><dt>{{ t('pages.connections.currentStatus') }}</dt><dd>{{ store.publicRuntimeStatus === 'ready' ? t('pages.connections.sharedServicesReady', { count: readyWorkspaces || workspaces.length }) : t('pages.connections.notAvailable') }}</dd></div>
          <div><dt>{{ t('pages.connections.purpose') }}</dt><dd>{{ t('pages.connections.publicPurpose') }}</dd></div>
        </dl>
      </article>
    </div>

    <section v-if="store.state?.capabilities?.subscribeProject" class="connection-subscriptions">
      <div class="section-title"><h3>{{ t('pages.connections.subscriptionsTitle') }}</h3><p>{{ t('pages.connections.subscriptionsCopy') }}</p></div>
      <div class="subscription-list">
        <div v-for="subscription in subscriptions" :key="`${subscription.provider_url}:${subscription.project_id}`" class="subscription-row">
          <span>↗</span>
          <div><strong>{{ subscription.project_name ?? subscription.project_id }}</strong><span>{{ t('pages.connections.sharedProject') }}</span></div>
          <button class="secondary-action subscription-action" type="button" @click="unsubscribe(subscription)">{{ t('pages.connections.unsubscribe') }}</button>
        </div>
        <div v-if="!subscriptions.length" class="empty-state">{{ t('pages.connections.noSubscriptions') }}</div>
      </div>
      <form class="subscription-form" @submit.prevent="subscribe">
        <SearchableSelect
          v-model="selectedProjectKey"
          :options="availableProjectOptions"
          :label="t('pages.connections.sharedProjectLabel')"
          :placeholder="t('pages.connections.choosePublicProject')"
          searchable
          required
        />
        <button type="submit">{{ t('pages.connections.subscribe') }}</button>
      </form>
    </section>
  </section>
</template>
