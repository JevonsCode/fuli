<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import RoundtableCreate from './RoundtableCreate.vue'
import RoundtableDetail from './RoundtableDetail.vue'
import { useRoundtables } from './use-roundtables'
import { copy, label, time } from './copy'
import './roundtables.css'
const route = useRoute(), router = useRouter()
const roomId = computed(() => typeof route.params.roomId === 'string' ? route.params.roomId : '')
const { rooms, snapshot, loading, loaded, error, refresh } = useRoundtables(roomId)
const creating = ref(false)
const hasLoadedContent = computed(() => roomId.value ? !!snapshot.value : loaded.value || creating.value)
async function created(id: string) { creating.value = false; await router.push(`/roundtables/${encodeURIComponent(id)}`) }
</script>

<template>
  <main class="rt-workspace"><header class="rt-page-header"><div><RouterLink class="rt-brand" to="/">Fuli <span>{{ copy('复利', '') }}</span></RouterLink><div class="rt-breadcrumb"><RouterLink to="/roundtables">{{ copy('Agent 圆桌', 'Agent Roundtable') }}</RouterLink><span class="rt-tag">Beta</span></div></div><div class="rt-actions"><RouterLink v-if="roomId" to="/roundtables">{{ copy('全部圆桌', 'All roundtables') }}</RouterLink><RouterLink to="/project-agents">{{ copy('Agent 目录', 'Agent directory') }}</RouterLink><LocaleSwitcher /></div></header>
    <div class="rt-page-content">
      <div v-if="error" class="rt-error rt-panel" role="alert"><strong>{{ copy('读取失败，保留已加载内容', 'Could not refresh; loaded content is preserved') }}</strong><p>{{ error }}</p><button type="button" :disabled="loading" @click="refresh">{{ copy('重试', 'Retry') }}</button></div>
      <GrowthLoading v-if="loading && !hasLoadedContent" :label="roomId ? '读取圆桌与公开消息 · Loading roundtable and shared messages' : '读取圆桌列表 · Loading roundtable list'" />
      <div v-if="loading && hasLoadedContent" class="rt-refresh-status"><GrowthLoading variant="inline" :label="roomId ? '刷新圆桌与公开消息 · Refreshing roundtable and shared messages' : '刷新圆桌列表 · Refreshing roundtable list'" /></div>
      <RoundtableDetail v-if="snapshot" :key="snapshot.room.id" :snapshot="snapshot" :refreshing="loading" @refresh="refresh" />
      <template v-else-if="!roomId">
        <section class="rt-intro"><div><p class="rt-eyebrow">{{ copy('一起讨论，分别执行，共同交付', 'Discuss together. Execute independently. Deliver with evidence.') }}</p><h1>{{ copy('让不同 Agent 围绕同一个目标工作。', 'Bring different agents around one shared goal.') }}</h1><p>{{ copy('身份和长期知识由 Fuli 管理。本次讨论、分工、回合与结果留在圆桌里，执行由获授权的参与端完成。', 'Fuli manages identity and lasting knowledge. This roundtable keeps discussion, tasks, turns and outcomes; authorized participant workers perform execution.') }}</p></div><button class="rt-primary" type="button" @click="creating = !creating">{{ copy('创建圆桌', 'Create roundtable') }}</button></section>
        <RoundtableCreate v-if="creating" @created="created" @cancel="creating = false" />
        <section class="rt-panel" aria-labelledby="rt-list-title"><div class="rt-section-heading"><h2 id="rt-list-title">{{ copy('你的圆桌', 'Your roundtables') }}</h2><button type="button" :disabled="loading" @click="refresh">{{ copy('刷新', 'Refresh') }}</button></div><div v-if="rooms.length" class="rt-room-list"><RouterLink v-for="room in rooms" :key="room.id" class="rt-room-card" :to="`/roundtables/${encodeURIComponent(room.id)}`"><div class="rt-section-heading"><span class="rt-tag">{{ label(room.status) }}</span><small>{{ label(room.mode) }}</small></div><h3>{{ room.goal }}</h3><p>{{ label(room.phase) }} · {{ room.seats.length }} {{ copy('位参与者', 'participants') }}</p><small>{{ time(room.updatedAt || room.createdAt) }}</small></RouterLink></div><p v-else-if="!loading && !error" class="rt-empty">{{ copy('还没有圆桌。创建一个目标明确的讨论或协作任务，邀请独立参与者加入。', 'No roundtables yet. Create a focused discussion or collaborative task and invite independent participants.') }}</p></section>
        <section class="rt-panel rt-capability-map" aria-labelledby="rt-map-title"><p class="rt-eyebrow">{{ copy('完整产品版图', 'Product capability map') }}</p><h2 id="rt-map-title">{{ copy('同一个协作层，连接长期知识与实际工作。', 'One collaboration layer connects lasting knowledge to real work.') }}</h2><ol><li><span class="rt-tag">{{ copy('已提供', 'Available') }}</span><strong>{{ copy('身份与知识', 'Identity and knowledge') }}</strong><p>{{ copy('Agent 职责、项目范围、确认状态与时间历史。按需读取，不因同桌共享私有记忆。', 'Agent roles, project scope, confirmation and temporal history. Retrieved on demand; shared rooms do not expose private memory.') }}</p></li><li><span class="rt-tag">Beta</span><strong>{{ copy('圆桌协作', 'Roundtable coordination') }}</strong><p>{{ copy('共同目标 → 讨论 → 分工 → 实施 → 审查 → 汇总与人工验收。', 'Shared goal → discussion → planning → implementation → review → synthesis and human acceptance.') }}</p></li><li><span class="rt-tag">Beta</span><strong>{{ copy('开放接入', 'Open adapters') }}</strong><p>{{ copy('CLI、MCP、xAI API；A2A 按已验证的协议能力试验接入。需要可调用接口、凭据和运行端。', 'CLI, MCP and xAI API. A2A is experimental within verified protocol capabilities. Requires a callable interface, credentials and a worker.') }}</p></li><li><span class="rt-tag">Beta</span><strong>{{ copy('跨电脑交付', 'Delivery across computers') }}</strong><p>{{ copy('一台协调端，各参与端主动领取授权回合；公开消息、分歧、产物和实际来源一起保留。', 'One coordinator; workers pull authorized turns. Shared messages, dissent, artifacts and actual sources stay together.') }}</p></li></ol><p class="rt-muted">{{ copy('Grok API 席位与现有 Grok Bot 分开：前者由工作端调用 xAI，后者需要在官方自定义 HTTPS MCP 设置中主动配置。没有开放接口的平台、云端常驻和完整 A2A 兼容仍待支持。Beta 能力不等于已通过每种模型、客户端和电脑的真实验收。', 'Grok API seats and existing Grok Bots are distinct: workers call xAI for the former; the latter require explicit setup through official HTTPS MCP settings. Closed platforms, always-on cloud hosting and full A2A compatibility remain future work. Beta availability does not imply live verification of every model, client and computer.') }}</p></section>
      </template>
    </div>
  </main>
</template>
