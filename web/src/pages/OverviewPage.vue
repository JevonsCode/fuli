<script setup lang="ts">
import { computed } from 'vue'

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
        <h3>知识在会话中静默生长</h3>
        <p>个人知识直接进入本机图谱；只有主动提交公共项目时才会进入发布审核。</p>
      </div>
      <span class="mode-chip">Agent structured</span>
    </div>

    <div class="metrics" aria-label="运行概览">
      <article><strong>{{ state?.personalSpaces.length ?? 0 }}</strong><span>个人图谱</span></article>
      <article><strong>{{ state?.projects.length ?? 0 }}</strong><span>可访问项目</span></article>
      <article><strong>{{ state?.subscriptions.length ?? 0 }}</strong><span>项目订阅</span></article>
      <article><strong>{{ state?.personalProjects?.length ?? 0 }}</strong><span>个人项目</span></article>
    </div>

    <div class="two-column">
      <section class="section-block">
        <div class="section-title"><h3>数据流</h3></div>
        <ol class="flow-list">
          <li><span>1</span><div><strong>Agent 识别稳定知识</strong><p>不保存整段会话和临时输出。</p></div></li>
          <li><span>2</span><div><strong>生成结构化实体与关系</strong><p>带来源、发现时象限、确认依据和幂等键。</p></div></li>
          <li><span>3</span><div><strong>按归属路由</strong><p>个人知识直接生效；主动提交公共时才经过审核。</p></div></li>
        </ol>
      </section>
      <section class="section-block">
        <div class="section-title"><h3>Provider</h3></div>
        <div class="provider-list">
          <div class="provider-row">
            <i :class="{ error: state?.providers?.personal?.status !== 'ready' }" />
            <div><strong>本地知识库</strong><span>Graphiti / Neo4j</span></div>
            <span class="provider-state">
              {{ state?.providers?.personal?.status === 'ready' ? '已连接' : '连接异常' }}
            </span>
          </div>
          <div class="provider-row">
            <i :class="store.publicRuntimeStatus" />
            <div>
              <strong>公共服务</strong>
              <span>
                {{ store.publicRuntimeStatus === 'ready'
                  ? `${readyWorkspaces || workspaceProviders.length} 个共享服务可用`
                  : store.publicRuntimeStatus === 'error' ? '已配置但暂时不可用' : '未连接 · 不影响本机' }}
              </span>
            </div>
            <span class="provider-state">
              {{ store.publicRuntimeStatus === 'ready' ? '已连接'
                : store.publicRuntimeStatus === 'error' ? '连接异常' : '未连接' }}
            </span>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
