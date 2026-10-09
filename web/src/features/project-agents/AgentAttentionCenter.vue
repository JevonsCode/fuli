<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { t } from '@/i18n'
import type { PersonalProject, ProjectAgentRecord } from '@/types'
import AgentHand from './AgentHand.vue'
import AttentionReply from './AttentionReply.vue'
import type { AttentionReplyDraft } from './attention-replies'
import { attentionTaskHref, useAgentAttention, type AgentAttention } from './attention-store'
const props = defineProps<{ personalSpaceId: string; projects: PersonalProject[] }>()
const attention = useAgentAttention()
const names = ref<Record<string, string>>({})
const drafts = ref<Record<string, AttentionReplyDraft & { revision: number }>>({})
const selectedId = ref('')
const busy = ref('')
let operation = 0
const responseErrors = ref<Record<string, string>>({})
const responseError = computed(() => responseErrors.value[selectedId.value] ?? '')
const selected = computed(() => attention.items.find(item => item.requestId === selectedId.value))
const draft = computed({
  get: () => drafts.value[selectedId.value] ?? { choice: '', text: '' },
  set: value => { if (selected.value) drafts.value[selectedId.value] = { ...value, revision: selected.value.revision } },
})
const projectNames = computed(() => new Map(props.projects.map(project => [project.project_id, project.profile.name])))
const requestOptions = computed(() => attention.items.map(item => ({
  value: item.requestId,
  label: item.title,
  meta: `${names.value[item.agentId] || t('attention.agentFallback')} · ${projectNames.value.get(item.personalProjectId) || t('attention.projectFallback')}`,
})))
watch(() => props.personalSpaceId, id => {
  operation++; busy.value = ''
  names.value = {}; drafts.value = {}; selectedId.value = ''; responseErrors.value = {}
  attention.setSpace(id === 'current' ? '' : id)
}, { immediate: true })
watch(() => attention.open, async open => {
  if (!open) return
  const space = attention.spaceId
  try {
    const agents = await getJson<ProjectAgentRecord[]>(`/api/project-agents?${new URLSearchParams({ personalSpaceId: space })}`)
    if (space === attention.spaceId) names.value = Object.fromEntries(agents.map(agent => [agent.agentId, agent.profile.displayName || agent.profile.name]))
  } catch { /* Requests remain usable when the directory is unavailable. */ }
})
watch(() => attention.items, items => {
  if (!items.some(item => item.requestId === selectedId.value)) selectedId.value = items[0]?.requestId ?? ''
  for (const item of items) {
    const saved = drafts.value[item.requestId]
    if (saved && saved.revision !== item.revision) {
      drafts.value[item.requestId] = { choice: '', text: saved.text, revision: item.revision }
      responseErrors.value[item.requestId] = t('attention.updated')
    }
  }
})
let timer: ReturnType<typeof setInterval> | undefined
function refreshVisible() { if (document.visibilityState === 'visible' && !attention.loading && !attention.open) void attention.refresh() }
onMounted(() => { timer = setInterval(refreshVisible, 30000); document.addEventListener('visibilitychange', refreshVisible) })
onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); attention.setSpace('') })
async function respond(item: AgentAttention, response: string) {
  if (busy.value || !response.trim() || response.length > 4096) return
  const space = attention.spaceId
  const currentOperation = ++operation
  busy.value = item.requestId; delete responseErrors.value[item.requestId]
  try {
    await attention.respond(item, response)
    if (currentOperation === operation && space === attention.spaceId) delete drafts.value[item.requestId]
  } catch (cause) {
    if (currentOperation === operation && space === attention.spaceId) {
      responseErrors.value[item.requestId] = cause instanceof Error ? cause.message : String(cause)
      await attention.refresh()
    }
  } finally { if (currentOperation === operation) busy.value = '' }
}
</script>

<template>
  <button class="space-nav-button attention-nav" :aria-label="attention.total ? `${t('attention.title')} · ${t('attention.count', { count: attention.total })}` : t('attention.title')" type="button" @click="attention.show()"><span class="nav-icon nav-icon-review" aria-hidden="true" /><span>{{ t('attention.title') }}</span><span class="attention-nav-status"><AgentHand passive count-only /><span v-if="attention.error" :title="t('attention.loadError')">!</span></span></button>
  <Teleport to="body">
    <UiDialog :open="attention.open" class="attention-dialog" size="xl" :busy="Boolean(busy)"
      :title="t('attention.title')" :description="t('attention.count', { count: attention.agentId ? attention.counts[attention.agentId] ?? attention.filteredTotal : attention.total })"
      @close="attention.open = false">
      <div v-if="attention.error" role="alert" class="attention-error"><span>{{ t('attention.loadError') }}</span><UiButton size="sm" :disabled="attention.loading" @click="attention.refresh()">{{ t('attention.refresh') }}</UiButton></div>
      <GrowthLoading v-if="attention.loading && !attention.items.length" variant="page" :label="t('attention.loading')" />
      <div v-else-if="!attention.items.length && !attention.error" class="attention-empty"><span aria-hidden="true">✓</span><p>{{ t('attention.empty') }}</p></div>
      <div v-else-if="attention.items.length" class="attention-workspace" :aria-busy="attention.loading">
        <aside class="attention-queue" :aria-label="t('attention.queue')">
          <div class="attention-queue-toolbar"><span>{{ attention.agentId ? names[attention.agentId] || t('attention.agentFallback') : t('attention.all') }}</span><UiButton v-if="attention.agentId || !attention.error" size="sm" variant="ghost" :disabled="attention.loading || Boolean(busy)" @click="attention.agentId ? attention.show() : attention.refresh()">{{ attention.agentId ? t('attention.all') : t('attention.refresh') }}</UiButton></div>
          <UiSelect v-model="selectedId" class="attention-mobile-picker" field :label="t('attention.selectRequest')" :options="requestOptions" :disabled="Boolean(busy)" />
          <div class="attention-request-list">
            <button v-for="item in attention.items" :key="item.requestId" type="button" class="attention-request" :class="{ 'is-selected': selectedId === item.requestId }" :aria-current="selectedId === item.requestId ? 'true' : undefined" :disabled="Boolean(busy)" @click="selectedId = item.requestId">
              <span class="attention-request-meta">{{ names[item.agentId] || t('attention.agentFallback') }}<span>{{ t(`attention.kinds.${item.kind}`) }}</span></span>
              <strong>{{ item.title }}</strong><span class="attention-request-project">{{ projectNames.get(item.personalProjectId) || t('attention.projectFallback') }}</span>
            </button>
          </div>
          <UiButton v-if="attention.items.length < attention.filteredTotal" class="attention-more" :disabled="attention.loading || Boolean(busy)" @click="attention.more()">{{ t('attention.more') }}</UiButton>
        </aside>
        <section v-if="selected" :key="selected.requestId" class="attention-detail">
          <div class="attention-detail-meta"><span>{{ names[selected.agentId] || t('attention.agentFallback') }} · {{ projectNames.get(selected.personalProjectId) || t('attention.projectFallback') }}</span><span class="ui-badge">{{ t(`attention.kinds.${selected.kind}`) }}</span></div>
          <AttentionReply v-model="draft" :item="selected" :busy="busy === selected.requestId" :refreshing="attention.loading" :error="responseError" @submit="respond(selected, $event)" />
          <a v-if="selected.taskId && !busy" class="attention-task-link" :href="attentionTaskHref(selected)" @click="attention.open = false">{{ t('attention.task') }} ↗</a>
        </section>
      </div>
    </UiDialog>
  </Teleport>
</template>

<style src="./attention.css"></style>
