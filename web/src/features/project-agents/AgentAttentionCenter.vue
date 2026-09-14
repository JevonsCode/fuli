<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'
import type { PersonalProject, ProjectAgentRecord } from '@/types'
import AgentHand from './AgentHand.vue'
import { useAgentAttention, type AgentAttention } from './attention-store'
const props = defineProps<{ personalSpaceId: string; projects: PersonalProject[] }>()
const attention = useAgentAttention()
const names = ref<Record<string, string>>({})
const namesLoading = ref(false)
const drafts = ref<Record<string, string>>({})
const busy = ref('')
const responseError = ref('')
const projectNames = computed(() => new Map(props.projects.map(project => [project.project_id, project.profile.name])))
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(() => attention.open, () => { if (!busy.value) attention.open = false })
watch(() => props.personalSpaceId, id => {
  names.value = {}
  namesLoading.value = false
  drafts.value = {}
  attention.setSpace(id === 'current' ? '' : id)
}, { immediate: true })
watch(() => attention.open, async open => {
  if (!open) return
  responseError.value = ''
  const space = attention.spaceId
  namesLoading.value = true
  try {
    const agents = await getJson<ProjectAgentRecord[]>(`/api/project-agents?${new URLSearchParams({ personalSpaceId: space })}`)
    if (space === attention.spaceId) names.value = Object.fromEntries(agents.map(agent => [agent.agentId, agent.profile.displayName || agent.profile.name]))
  } catch { /* Request content remains available if the directory is unavailable. */ }
  finally {
    if (space === attention.spaceId) namesLoading.value = false
  }
})
let timer: ReturnType<typeof setInterval> | undefined
function refreshVisible() { if (document.visibilityState === 'visible' && !attention.loading && !attention.open) void attention.refresh() }
onMounted(() => { timer = setInterval(refreshVisible, 30000); document.addEventListener('visibilitychange', refreshVisible) })
onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); attention.setSpace('') })
async function respond(item: AgentAttention) {
  if (busy.value || !drafts.value[item.requestId]?.trim()) return
  busy.value = item.requestId; responseError.value = ''
  try { await attention.respond(item, drafts.value[item.requestId]!.trim()); delete drafts.value[item.requestId] }
  catch (cause) { responseError.value = cause instanceof Error ? cause.message : String(cause); await attention.refresh() }
  finally { busy.value = '' }
}
</script>

<template>
  <button class="space-nav-button attention-nav" type="button" @click="attention.show()"><span>{{ t('attention.title') }}</span><AgentHand passive /><span v-if="attention.error" :title="t('attention.loadError')">!</span></button>
  <Teleport to="body">
    <dialog v-if="attention.open" ref="dialogRef" class="employee-dialog attention-dialog" aria-labelledby="attention-title" @cancel="onCancel" @keydown="onKeydown">
      <div class="employee-dialog-shell">
        <header><h2 id="attention-title">{{ attention.agentId ? names[attention.agentId] || t('attention.title') : t('attention.title') }}</h2><button ref="initialFocusRef" type="button" :disabled="Boolean(busy)" :aria-label="t('attention.close')" @click="attention.open = false">×</button></header>
        <div class="employee-dialog-body">
          <div class="attention-toolbar"><button v-if="attention.agentId" type="button" @click="attention.show()">{{ t('attention.all') }}</button><button type="button" :disabled="attention.loading || Boolean(busy)" @click="attention.refresh()">{{ t('attention.refresh') }}</button></div>
          <p v-if="attention.error" role="alert" class="employee-dialog-error">{{ t('attention.loadError') }} · {{ attention.error }}</p>
          <p v-if="responseError" role="alert" class="employee-dialog-error">{{ responseError }}</p>
          <GrowthLoading v-if="namesLoading" variant="inline" :label="t('attention.loadingAgents')" />
          <GrowthLoading v-if="attention.loading" variant="compact" :label="t('attention.loading')" />
          <p v-else-if="!attention.items.length && !attention.error">{{ t('attention.empty') }}</p>
          <article v-for="item in attention.items" :key="item.requestId" class="attention-item">
            <p class="attention-meta">{{ names[item.agentId] || item.agentId }} · {{ projectNames.get(item.personalProjectId) || item.personalProjectId }} · {{ t(`attention.kinds.${item.kind}`) }}</p>
            <h3>{{ item.title }}</h3><p>{{ item.detail }}</p>
            <p class="attention-action">{{ item.requestedAction }}</p>
            <a v-if="item.taskId" :href="`/project-agents?agent=${encodeURIComponent(item.agentId)}`" @click="attention.open = false">{{ t('attention.task') }}</a>
            <form @submit.prevent="respond(item)"><label :for="`attention-${item.requestId}`">{{ t('attention.response') }}</label><textarea :id="`attention-${item.requestId}`" v-model="drafts[item.requestId]" rows="2" maxlength="4096" required :disabled="Boolean(busy)" /><button type="submit" class="primary" :disabled="Boolean(busy) || !drafts[item.requestId]?.trim()"><GrowthLoading v-if="busy === item.requestId" variant="inline" :label="t('attention.sending')" /><span v-else>{{ t('attention.send') }}</span></button></form>
          </article>
          <button v-if="attention.items.length < attention.filteredTotal" type="button" :disabled="attention.loading" @click="attention.more()">{{ t('attention.more') }}</button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style src="../employees/employee-dialog.css"></style>
<style scoped>
.attention-nav { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.attention-dialog { width: min(700px, calc(100vw - 32px)); }
.attention-toolbar { display: flex; gap: 8px; justify-content: flex-end; }
.attention-item { padding-block: 6px 24px; border-bottom: 1px solid #e0e7e2; overflow-wrap: anywhere; }
.attention-item:last-child { border-bottom: 0; padding-bottom: 0; }
.attention-item h3 { font-size: 17px; margin: 8px 0; }
.attention-item .attention-meta { font-size: 12px; color: #526659; }
.attention-item .attention-action { font-weight: 650; margin-block: 12px; }
.attention-item form { display: grid; gap: 8px; margin-top: 16px; }
.attention-item form button { justify-self: end; }
.attention-item form label { font-size: 13px; }
.attention-item a { color: #315c43; }
@media (max-width: 640px) { .attention-item textarea { font-size: 16px; } }
</style>
