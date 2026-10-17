<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import AttentionReply from './AttentionReply.vue'
import type { AttentionReplyDraft } from './attention-replies'
import { attentionTaskHref, inboxLocation, useAgentAttention, type AgentAttention } from './attention-store'

// The inbox body: request queue on one side, the selected request and reply on the other.
const props = defineProps<{ personalSpaceId: string; projects: PersonalProject[]; focusRequestId?: string }>()
const attention = useAgentAttention()
// Names are read only for the Agents with open requests; requests stay usable without them.
const agentRecords = useAgentRecords(
  computed(() => (attention.open ? attention.spaceId : '')),
  computed(() => [...attention.items.map(item => item.agentId), ...(attention.agentId ? [attention.agentId] : [])]),
)
const names = computed<Record<string, string>>(() => Object.fromEntries(
  Object.entries(agentRecords.records.value).map(([id, agent]) => [id, agent.profile.displayName || agent.profile.name]),
))
const selectedId = ref('')
const busy = ref('')
let operation = 0
const responseError = computed(() => attention.responseErrors[selectedId.value] ?? '')
const selected = computed(() => attention.items.find(item => item.requestId === selectedId.value))
const draft = computed<AttentionReplyDraft>({
  get: () => attention.drafts[selectedId.value] ?? { choice: '', text: '' },
  set: value => { if (selected.value) attention.drafts[selectedId.value] = { ...value, revision: selected.value.revision } },
})
const projectNames = computed(() => new Map(props.projects.map(project => [project.project_id, project.profile.name])))
const pendingCount = computed(() => attention.agentId ? attention.counts[attention.agentId] ?? attention.filteredTotal : attention.total)
const requestOptions = computed(() => attention.items.map(item => ({
  value: item.requestId,
  label: item.title,
  meta: `${names.value[item.agentId] || t('attention.agentFallback')} · ${projectNames.value.get(item.personalProjectId) || t('attention.projectFallback')}`,
})))
watch(() => props.personalSpaceId, id => {
  operation++; busy.value = ''
  selectedId.value = ''
  attention.setSpace(id === 'current' ? '' : id)
}, { immediate: true })
watch(() => attention.items, items => {
  if (!items.some(item => item.requestId === selectedId.value)) {
    selectedId.value = items.find(item => item.requestId === props.focusRequestId)?.requestId ?? items[0]?.requestId ?? ''
  }
  for (const item of items) {
    const saved = attention.drafts[item.requestId]
    if (saved && saved.revision !== item.revision) {
      attention.drafts[item.requestId] = { choice: '', text: saved.text, revision: item.revision }
      attention.responseErrors[item.requestId] = t('attention.updated')
    }
  }
}, { immediate: true })
// A new link target (overview item, Back/Forward) selects that request even while another stays open.
watch(() => props.focusRequestId, targetId => {
  if (targetId && attention.items.some(item => item.requestId === targetId)) selectedId.value = targetId
})
async function respond(item: AgentAttention, response: string) {
  if (busy.value || !response.trim() || response.length > 4096) return
  const space = attention.spaceId
  const currentOperation = ++operation
  busy.value = item.requestId; delete attention.responseErrors[item.requestId]
  try {
    await attention.respond(item, response)
  } catch (cause) {
    if (currentOperation === operation && space === attention.spaceId) {
      attention.responseErrors[item.requestId] = cause instanceof Error ? cause.message : String(cause)
      await attention.refresh()
    }
  } finally { if (currentOperation === operation) busy.value = '' }
}
</script>

<template>
  <div class="attention-page-body">
    <p class="ui-meta attention-page-count" role="status">{{ pendingCount ? t('attention.count', { count: pendingCount }) : '' }}</p>
    <div v-if="attention.error" role="alert" class="attention-error"><span>{{ t('attention.loadError') }}</span><UiButton size="sm" :disabled="attention.loading" @click="attention.refresh()">{{ t('attention.refresh') }}</UiButton></div>
    <GrowthLoading v-if="attention.loading && !attention.items.length" variant="page" :label="t('attention.loading')" />
    <div v-else-if="!attention.items.length && !attention.error" class="attention-empty"><span aria-hidden="true">✓</span><p>{{ t('attention.empty') }}</p></div>
    <div v-else-if="attention.items.length" class="attention-workspace" :aria-busy="attention.loading">
      <aside class="attention-queue" :aria-label="t('attention.queue')">
        <div class="attention-queue-toolbar">
          <span>{{ attention.agentId ? names[attention.agentId] || t('attention.agentFallback') : t('attention.all') }}</span>
          <RouterLink v-if="attention.agentId" class="ui-button ui-button--ghost ui-button--sm" :to="inboxLocation()">{{ t('attention.all') }}</RouterLink>
          <UiButton v-else-if="!attention.error" size="sm" variant="ghost" :disabled="attention.loading || Boolean(busy)" @click="attention.refresh()">{{ t('attention.refresh') }}</UiButton>
        </div>
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
        <a v-if="selected.taskId && !busy" class="attention-task-link" :href="attentionTaskHref(selected)">{{ t('attention.task') }} ↗</a>
      </section>
    </div>
  </div>
</template>

<style src="./attention.css"></style>
