<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { focusReturnTarget } from '@/composables/useFocusReturn'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import AttentionPeek from './AttentionPeek.vue'
import TaskBlockerNotice from './TaskBlockerNotice.vue'
import type { AttentionAnswer, AttentionReplyDraft } from './attention-replies'
import { inboxLocation, useAgentAttention, type AgentAttention, type AttentionPeekState } from './attention-store'

// The inbox body: the queue as cards on one canvas; a request opens in a
// centred quick look (Peek) with its reply. The page keeps which request is
// open in the URL; this component only asks to open or close it.
const props = defineProps<{ personalSpaceId: string; projects: PersonalProject[]; openRequestId?: string }>()
const emit = defineEmits<{ open: [requestId: string]; close: [] }>()
const attention = useAgentAttention()
// Names are read only for the Agents with open requests; requests stay usable without them.
const agentRecords = useAgentRecords(
  computed(() => (attention.open ? attention.spaceId : '')),
  computed(() => [...attention.items.map(item => item.agentId), ...(attention.agentId ? [attention.agentId] : []),
    ...(attention.lastReply ? [attention.lastReply.agentId] : [])]),
)
const names = computed<Record<string, string>>(() => Object.fromEntries(
  Object.entries(agentRecords.records.value).map(([id, agent]) => [id, agent.profile.displayName || agent.profile.name]),
))
const selectedId = computed(() => props.openRequestId ?? '')
const busy = ref('')
let operation = 0
const responseError = computed(() => attention.responseErrors[selectedId.value] ?? '')
// A request on the loaded page comes from the queue; any other is read by its identity
// at once, without waiting for the queue, so a link opens even beyond the first page.
// When the queue arrives with it, the queue's copy takes over without another read.
const linked = computed(() => attention.linked?.requestId === selectedId.value ? attention.linked : null)
const selected = computed(() => attention.items.find(item => item.requestId === selectedId.value) ?? linked.value?.item)
const peekState = computed<AttentionPeekState>(() => {
  if (selected.value) return selected.value.status === 'open' ? 'open' : 'handled'
  return linked.value?.state === 'missing' || linked.value?.state === 'failed' ? linked.value.state : 'loading'
})
watch([selectedId, () => attention.spaceId], ([id, space]) => {
  if (id && space && !attention.items.some(item => item.requestId === id) && attention.linked?.requestId !== id) {
    void attention.loadRequest(id)
  }
}, { immediate: true })
const draft = computed<AttentionReplyDraft>({
  get: () => attention.drafts[selectedId.value] ?? { choice: '', text: '' },
  set: value => { if (selected.value) attention.drafts[selectedId.value] = { ...value, revision: selected.value.revision } },
})
// Says only what happened to the reply; it never claims the work itself resumed.
const replyOutcome = computed(() => attention.lastReply && t(`attention.delivery.${attention.lastReply.status}`, {
  agent: names.value[attention.lastReply.agentId] || t('attention.agentFallback'), title: attention.lastReply.title,
}))
const projectNames = computed(() => new Map(props.projects.map(project => [project.project_id, project.profile.name])))
const pendingCount = computed(() => attention.agentId ? attention.counts[attention.agentId] ?? attention.filteredTotal : attention.total)
const agentName = (item: AgentAttention) => names.value[item.agentId] || t('attention.agentFallback')
const projectName = (item: AgentAttention) => projectNames.value.get(item.personalProjectId) || t('attention.projectFallback')
watch(() => props.personalSpaceId, id => {
  operation++; busy.value = ''
  attention.setSpace(id === 'current' ? '' : id)
}, { immediate: true })
watch(() => linked.value?.item ? [...attention.items, linked.value.item] : attention.items, items => {
  for (const item of items) {
    const saved = attention.drafts[item.requestId]
    if (saved && saved.revision !== item.revision) {
      attention.drafts[item.requestId] = { choice: '', text: saved.text, revision: item.revision }
      attention.responseErrors[item.requestId] = t('attention.updated')
    }
  }
}, { immediate: true })

// Focus goes back to the card that opened the Peek, or to the request's card after a link.
const root = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null
let lastOpenedId = ''
watch(selectedId, id => { if (id) lastOpenedId = id }, { immediate: true })
function openRequest(requestId: string) {
  const active = document.activeElement
  opener = active instanceof HTMLElement && active !== document.body ? active : null
  emit('open', requestId)
}
// Opening lands on the first reply choice, so the keyboard starts answering; Esc goes back.
function focusReply(event: Event) {
  const choice = (event.target as HTMLElement | null)?.querySelector<HTMLElement>('.attention-choices input:not(:disabled)')
  if (!choice) return
  event.preventDefault()
  choice.focus()
}
// A reply being sent keeps the Peek open, so its outcome or error lands where it was written.
function peekOpenChange(open: boolean) { if (!open && !busy.value) emit('close') }
function returnFocus(event: Event) {
  event.preventDefault()
  const target = opener
  opener = null
  if (target?.isConnected) target.focus({ preventScroll: true })
  else focusReturnTarget(root.value, lastOpenedId)
}

async function respond(item: AgentAttention, answer: AttentionAnswer) {
  if (busy.value) return
  const space = attention.spaceId
  const currentOperation = ++operation
  busy.value = item.requestId; delete attention.responseErrors[item.requestId]
  try {
    await attention.respond(item, answer)
    // The reply is recorded and the request left the queue: back to the canvas, which says where it went.
    if (currentOperation === operation && selectedId.value === item.requestId) emit('close')
  } catch (cause) {
    if (currentOperation === operation && space === attention.spaceId) {
      attention.responseErrors[item.requestId] = cause instanceof Error ? cause.message : String(cause)
      await attention.refresh()
    }
  } finally { if (currentOperation === operation) busy.value = '' }
}
</script>

<template>
  <div ref="root" class="attention-page-body">
    <div class="attention-toolbar flex flex-wrap items-center gap-2">
      <span class="attention-page-count text-sm text-muted-foreground" :class="{ 'ui-sr-only': !pendingCount && !attention.agentId }" role="status">{{ attention.agentId ? names[attention.agentId] || t('attention.agentFallback') : t('attention.all') }} · {{ t('attention.count', { count: pendingCount }) }}</span>
      <div class="ml-auto flex items-center gap-2">
        <GrowthLoading v-if="attention.loading && attention.items.length" variant="inline" :label="t('attention.loading')" />
        <Button v-if="attention.agentId" as-child variant="outline" size="sm"><RouterLink :to="inboxLocation()">{{ t('attention.all') }}</RouterLink></Button>
      </div>
    </div>
    <p v-if="attention.lastReply" class="attention-outcome" :class="`is-${attention.lastReply.status}`" role="status">{{ replyOutcome }}</p>
    <div v-if="attention.error" role="alert" class="attention-error"><span>{{ t('attention.loadError') }}</span><Button variant="outline" size="sm" :disabled="attention.loading" @click="attention.refresh()">{{ t('attention.refresh') }}</Button></div>
    <GrowthLoading v-if="attention.loading && !attention.items.length" variant="page" :label="t('attention.loading')" />
    <div v-else-if="!attention.items.length && !attention.error" class="attention-empty"><span aria-hidden="true">✓</span><p>{{ t('attention.empty') }}</p></div>
    <template v-else-if="attention.items.length">
      <ul class="attention-request-list m-0 grid list-none grid-cols-1 gap-3 p-0 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4"
        :aria-label="t('attention.queue')" :aria-busy="attention.loading">
        <li v-for="item in attention.items" :key="item.requestId" class="min-w-0">
          <article class="attention-request flex h-full min-w-0 flex-col gap-2 rounded-lg border bg-card px-4 pt-3.5 pb-3 transition-[border-color,box-shadow] hover:border-border-strong"
            :class="{ 'is-selected border-border-strong shadow-md': selectedId === item.requestId }" :data-return-focus="item.requestId">
            <p class="m-0 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span class="min-w-0 truncate">{{ agentName(item) }}</span>
              <Badge class="ml-auto" variant="secondary" :title="t(`attention.kinds.${item.kind}`)">{{ t(`attention.kinds.${item.kind}`) }}</Badge>
            </p>
            <button type="button" class="attention-request-title" :disabled="Boolean(busy)" aria-haspopup="dialog" @click="openRequest(item.requestId)">{{ item.title }}</button>
            <TaskBlockerNotice v-if="item.taskBlocker" compact :blocker="item.taskBlocker" />
            <p class="m-0 mt-auto min-w-0 truncate text-xs text-muted-foreground" :title="projectName(item)">{{ projectName(item) }}</p>
          </article>
        </li>
      </ul>
      <Button v-if="attention.items.length < attention.filteredTotal" variant="outline" class="attention-more" :disabled="attention.loading || Boolean(busy)" @click="attention.more()">{{ t('attention.more') }}</Button>
    </template>

    <Dialog :open="Boolean(selectedId)" @update:open="peekOpenChange">
      <DialogContent size="lg" data-attention-peek-dialog @open-auto-focus="focusReply" @close-auto-focus="returnFocus">
        <AttentionPeek
          :item="selected"
          :state="peekState"
          :agent-name="selected ? agentName(selected) : ''"
          :project-name="selected ? projectName(selected) : ''"
          :draft="draft"
          :busy="busy === selectedId"
          :refreshing="attention.loading"
          :error="responseError"
          @update:draft="draft = $event"
          @submit="selected && respond(selected, $event)"
          @retry="attention.loadRequest(selectedId)"
        />
      </DialogContent>
    </Dialog>
  </div>
</template>

<style src="./attention.css"></style>
