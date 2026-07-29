<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import fuliLogoUrl from '../../assets/brand/fuli-logo.png'
import { personalProjectsPath, knowledgePath } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'

const store = useConsoleStore()
const route = useRoute()

const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? 'current')
const personalProjectsTo = computed(() => personalProjectsPath(activeSpaceId.value, 'graph'))
const knowledgeTo = computed(() => knowledgePath('personal', activeSpaceId.value, 'directory'))
const title = computed(() => String(route.meta.title ?? '概览'))
const eyebrow = computed(() => String(route.meta.eyebrow ?? 'LOCAL + FEDERATED'))
const description = computed(() => String(route.meta.description ?? ''))
const publicReady = computed(() => store.publicRuntimeStatus === 'ready')
const publicRuntimeLabel = computed(() => {
  if (store.publicRuntimeStatus === 'ready') return '公共服务已连接'
  if (store.publicRuntimeStatus === 'error') return '公共服务连接异常'
  return '公共服务未连接'
})
const publicRuntimeCopy = computed(() => {
  if (store.publicRuntimeStatus === 'ready') return '公共项目与协作可用'
  if (store.publicRuntimeStatus === 'error') return '本地知识库不受影响'
  return '当前仅使用本机'
})
const captureEnabled = computed(() => store.state?.capturePolicy?.enabled !== false)
const agentAccessEnabled = computed(() =>
  store.state?.agentAccessPolicy?.enabled !== false,
)
const publicVisible = computed(() => store.state?.capabilities?.browsePublicProjects !== false)
const reviewVisible = computed(() => {
  const capabilities = store.state?.capabilities
  return capabilities?.submitKnowledge !== false || capabilities?.reviewProposals === true
})

onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
})

function toggleCapture(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  void store.updateCapturePolicy(input.checked)
}

function toggleAgentAccess(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  void store.updateAgentAccessPolicy(input.checked)
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-block">
        <img class="brand-mark" :src="fuliLogoUrl" alt="" aria-hidden="true" />
        <div>
          <h1>复利</h1>
          <p>Context Graph</p>
        </div>
      </div>

      <nav class="primary-nav" aria-label="主导航">
        <p class="nav-section-label">工作台</p>
        <RouterLink to="/" exact-active-class="is-active">
          <span class="nav-icon nav-icon-overview" aria-hidden="true" />
          <span class="nav-label">概览</span>
        </RouterLink>

        <p class="nav-section-label nav-space-label">个人空间</p>
        <RouterLink class="space-nav-button personal-profile-button" to="/preferences" active-class="is-active">
          <span class="nav-icon nav-icon-personal-profile" aria-hidden="true" />
          <span class="nav-copy"><strong>协作偏好</strong><small>全局 / 项目 · 仅本机</small></span>
        </RouterLink>
        <RouterLink class="space-nav-button knowledge-organizer-button" to="/organize" active-class="is-active">
          <span class="nav-icon nav-icon-knowledge-organizer" aria-hidden="true" />
          <span class="nav-copy"><strong>知识整理</strong><small>象限 · 依据 · 状态</small></span>
        </RouterLink>
        <RouterLink class="space-nav-button personal-space-button" :to="personalProjectsTo" active-class="is-active">
          <span class="nav-icon nav-icon-personal-project" aria-hidden="true" />
          <span class="nav-copy"><strong>个人项目</strong><small>本机 · 私有</small></span>
        </RouterLink>

        <template v-if="publicVisible">
          <p class="nav-section-label nav-public-label">公共空间</p>
          <RouterLink class="space-nav-button public-space-button" to="/public-projects" active-class="is-active">
            <span class="nav-icon nav-icon-public-project" aria-hidden="true" />
            <span class="nav-copy"><strong>公共项目</strong><small>发现 · 订阅 · 协作</small></span>
          </RouterLink>
        </template>

        <p class="nav-section-label nav-tool-label">知识与治理</p>
        <RouterLink :to="knowledgeTo" active-class="is-active">
          <span class="nav-icon nav-icon-knowledge-graph" aria-hidden="true" />
          <span class="nav-label">知识库</span>
        </RouterLink>
        <RouterLink v-if="reviewVisible" to="/review" active-class="is-active">
          <span class="nav-icon nav-icon-review" aria-hidden="true" />
          <span class="nav-label">发布审核</span>
        </RouterLink>
        <RouterLink to="/connections" active-class="is-active">
          <span class="nav-icon nav-icon-connections" aria-hidden="true" />
          <span class="nav-label">服务连接</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <div class="service-runtime-list" aria-label="知识服务状态">
          <div class="runtime-status">
            <span class="status-dot" :class="store.runtimeStatus" />
            <div>
              <strong>
                {{ store.runtimeStatus === 'ready' ? '本地知识库已连接'
                  : store.runtimeStatus === 'error' ? '本地知识库连接失败'
                    : '正在连接本地知识库' }}
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
        <label
          class="capture-setting"
          :data-enabled="captureEnabled"
          :title="captureEnabled ? '已开启自动沉淀' : '已关闭自动沉淀'"
        >
          <span>自动沉淀</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="自动沉淀会话内容"
            :aria-checked="captureEnabled"
            :checked="captureEnabled"
            :disabled="store.runtimeStatus !== 'ready'"
            @change="toggleCapture"
          />
          <i aria-hidden="true" />
        </label>
        <label
          class="capture-setting agent-access-setting"
          :data-enabled="agentAccessEnabled"
          :title="
            agentAccessEnabled
              ? '已允许 Agent 调用 FULI'
              : '已禁止所有 Agent 调用 FULI'
          "
        >
          <span>
            <strong>Agent 使用</strong>
            <small>{{ agentAccessEnabled ? '允许调用整个 FULI' : '所有调用已拦截' }}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="允许 Agent 调用 FULI"
            :aria-checked="agentAccessEnabled"
            :checked="agentAccessEnabled"
            :disabled="store.runtimeStatus !== 'ready'"
            @change="toggleAgentAccess"
          />
          <i aria-hidden="true" />
        </label>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div class="topbar-heading">
          <p class="eyebrow">{{ eyebrow }}</p>
          <h2>{{ title }}</h2>
          <p v-if="description" class="topbar-description">{{ description }}</p>
        </div>
        <div class="topbar-actions">
          <span v-if="publicReady" class="mode-chip">Public ready</span>
          <button class="quiet-button" type="button" @click="store.refresh">刷新</button>
        </div>
      </header>

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
