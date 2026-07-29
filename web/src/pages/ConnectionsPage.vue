<script setup lang="ts">
import { computed, ref } from 'vue'

import { deleteJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
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
    store.notify(`已订阅“${project.name}”。`)
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
    store.notify(`已取消订阅“${subscription.project_name ?? subscription.project_id}”。`)
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  }
}
</script>

<template>
  <section class="view connections-view">
    <div class="connection-intro">
      <h3>服务连接与订阅</h3>
      <p>本地知识库始终独立运行；公共能力只在连接共享 Provider 后开启。</p>
    </div>
    <div class="service-connection-grid" aria-label="知识服务连接状态">
      <article class="service-connection-card" :data-status="personalReady ? 'ready' : 'error'">
        <header>
          <span class="service-connection-icon local" aria-hidden="true"><span class="nav-icon nav-icon-personal-project" /></span>
          <div><p>LOCAL KNOWLEDGE</p><h3>本地 Graphiti</h3></div>
          <span class="service-state">{{ personalReady ? '已连接' : '连接异常' }}</span>
        </header>
        <p>{{ personalReady ? '个人项目、协作偏好和会话知识正在写入本机图谱。' : '本地知识库暂时无法使用，请检查 Graphiti 与 Neo4j。' }}</p>
        <dl><div><dt>存储</dt><dd>Neo4j</dd></div><div><dt>用途</dt><dd>个人项目与协作偏好</dd></div></dl>
      </article>

      <article class="service-connection-card" :data-status="store.publicRuntimeStatus">
        <header>
          <span class="service-connection-icon public" aria-hidden="true"><span class="nav-icon nav-icon-public-project" /></span>
          <div><p>PUBLIC PROVIDER</p><h3>公共服务</h3></div>
          <span class="service-state">{{ store.publicRuntimeStatus === 'ready' ? '已连接' : store.publicRuntimeStatus === 'error' ? '连接异常' : '未连接' }}</span>
        </header>
        <p>{{ store.publicRuntimeStatus === 'ready' ? '公共项目、订阅、发布与团队协作功能已经可以使用。' : store.publicRuntimeStatus === 'error' ? '公共服务已经配置，但当前无法访问；本地知识库仍可正常使用。' : '当前未连接公共服务；公共能力保持关闭。' }}</p>
        <dl>
          <div><dt>当前状态</dt><dd>{{ store.publicRuntimeStatus === 'ready' ? `${readyWorkspaces || workspaces.length} 个共享服务可用` : '尚未可用' }}</dd></div>
          <div><dt>用途</dt><dd>发现、订阅、发布与协作</dd></div>
        </dl>
      </article>
    </div>

    <section v-if="store.state?.capabilities?.subscribeProject" class="connection-subscriptions">
      <div class="section-title"><h3>公共项目订阅</h3><p>只把你主动选择的公共项目加入个人检索范围。</p></div>
      <div class="subscription-list">
        <div v-for="subscription in subscriptions" :key="`${subscription.provider_url}:${subscription.project_id}`" class="subscription-row">
          <span>↗</span>
          <div><strong>{{ subscription.project_name ?? subscription.project_id }}</strong><span>团队共享项目</span></div>
          <button class="secondary-action subscription-action" type="button" @click="unsubscribe(subscription)">取消订阅</button>
        </div>
        <div v-if="!subscriptions.length" class="empty-state">尚未订阅团队共享项目</div>
      </div>
      <form class="subscription-form" @submit.prevent="subscribe">
        <SearchableSelect
          v-model="selectedProjectKey"
          :options="availableProjectOptions"
          label="团队共享项目"
          placeholder="选择公共项目"
          searchable
          required
        />
        <button type="submit">订阅项目</button>
      </form>
    </section>
  </section>
</template>
