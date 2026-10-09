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
  <main class="rt-workspace"><header class="rt-page-header"><div><RouterLink class="rt-brand" to="/">Fuli <span>{{ copy('复利', '') }}</span></RouterLink><div class="rt-breadcrumb"><RouterLink to="/roundtables">{{ copy('Agent 圆桌', 'Agent Roundtable') }}</RouterLink></div></div><div class="rt-actions"><RouterLink v-if="roomId" to="/roundtables">{{ copy('全部圆桌', 'All roundtables') }}</RouterLink><RouterLink to="/project-agents">{{ copy('Agent 目录', 'Agent directory') }}</RouterLink><LocaleSwitcher /></div></header>
    <div class="rt-page-content">
      <div v-if="error" class="rt-error rt-panel" role="alert"><strong>{{ copy('读取失败，保留已加载内容', 'Could not refresh; loaded content is preserved') }}</strong><p>{{ error }}</p><button type="button" :disabled="loading" @click="refresh">{{ copy('重试', 'Retry') }}</button></div>
      <GrowthLoading v-if="loading && !hasLoadedContent" :label="roomId ? '读取圆桌与公开消息 · Loading roundtable and shared messages' : '读取圆桌列表 · Loading roundtable list'" />
      <div v-if="loading && hasLoadedContent" class="rt-refresh-status"><GrowthLoading variant="inline" :label="roomId ? '刷新圆桌与公开消息 · Refreshing roundtable and shared messages' : '刷新圆桌列表 · Refreshing roundtable list'" /></div>
      <RoundtableDetail v-if="snapshot" :key="snapshot.room.id" :snapshot="snapshot" :refreshing="loading" @refresh="refresh" />
      <template v-else-if="!roomId">
        <section class="rt-intro"><div><h1>{{ copy('让不同 Agent 围绕同一个目标工作。', 'Bring different agents around one shared goal.') }}</h1><p>{{ copy('身份和长期知识由 Fuli 管理。本次讨论、分工、回合与结果留在圆桌里，执行由获授权的参与端完成。', 'Fuli manages identity and lasting knowledge. This roundtable keeps discussion, tasks, turns and outcomes; authorized participant workers perform execution.') }}</p></div><button class="rt-primary" type="button" @click="creating = !creating">{{ copy('创建圆桌', 'Create roundtable') }}</button></section>
        <RoundtableCreate v-if="creating" @created="created" @cancel="creating = false" />
        <section class="rt-panel" aria-labelledby="rt-list-title"><div class="rt-section-heading"><h2 id="rt-list-title">{{ copy('你的圆桌', 'Your roundtables') }}</h2><button type="button" :disabled="loading" @click="refresh">{{ copy('刷新', 'Refresh') }}</button></div><div v-if="rooms.length" class="rt-room-list"><RouterLink v-for="room in rooms" :key="room.id" class="rt-room-card" :to="`/roundtables/${encodeURIComponent(room.id)}`"><div class="rt-section-heading"><span class="rt-tag">{{ label(room.status) }}</span><small>{{ label(room.mode) }}</small></div><h3>{{ room.goal }}</h3><p>{{ label(room.phase) }} · {{ room.seats.length }} {{ copy('位参与者', 'participants') }}</p><small>{{ time(room.updatedAt || room.createdAt) }}</small></RouterLink></div><p v-else-if="!loading && !error" class="rt-empty">{{ copy('还没有圆桌。创建一个目标明确的讨论或协作任务，邀请独立参与者加入。', 'No roundtables yet. Create a focused discussion or collaborative task and invite independent participants.') }}</p></section>
      </template>
    </div>
  </main>
</template>
