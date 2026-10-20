<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import type { ConversationLauncherConfiguration, KnowledgeGraph, KnowledgeItem } from '@/types'
import KnowledgeRecords from './KnowledgeRecords.vue'
import { agentConfirmationBlockingText, agentConfirmationProgressText, showsAgentConfirmationProgress } from './agent-confirmation-progress'
import { classificationExplanation, confirmationActorLabel, endpointId, formatTime, humanChangeStatusLabel, isManagementKnowledgeItem, knowledgeItems, knowledgeReviewState, reviewStateLabel } from './model'
const props = defineProps<{ item: KnowledgeItem; graph: KnowledgeGraph | null; editable?: boolean; scopeLabel?: string; statusLabel?: string; conversationLaunchers?: ConversationLauncherConfiguration }>()
const emit = defineEmits<{ confirm: [item: KnowledgeItem]; edit: [item: KnowledgeItem]; openReplacement: [item: KnowledgeItem] }>()
const bodyElement = ref<HTMLElement | null>(null)
const fullText = ref(false)
const longText = ref(false)
const managed = computed(() => isManagementKnowledgeItem(props.item))
const canConfirm = computed(() => props.editable && !managed.value && !props.item.invalidAt && props.item.classificationExplicit && knowledgeReviewState(props.item) === 'pending')
const basis = computed(() => props.item.confirmationBasis)
const replacement = computed(() => knowledgeItems(props.graph).find(item => item.id === props.item.replacedByItemId && item.itemKind === props.item.replacedByItemKind) ?? null)
const related = computed(() => props.item.itemKind === 'entity' ? props.graph?.edges.filter(edge => endpointId(edge.source) === props.item.id || endpointId(edge.target) === props.item.id).slice(0, 12) ?? [] : [])
const basisRows = computed(() => basis.value ? [
  ['knowledge.workspace.inspector.basis.existence', basis.value.existence_reason],
  ['knowledge.workspace.inspector.basis.quadrant', basis.value.quadrant_reason],
  ['knowledge.workspace.inspector.basis.proposer', basis.value.proposed_by ? confirmationActorLabel(basis.value.proposed_by) : null],
  ['knowledge.workspace.inspector.basis.confirmer', basis.value.confirmed_by ? confirmationActorLabel(basis.value.confirmed_by) : null],
  ['knowledge.workspace.inspector.basis.time', basis.value.confirmed_at ? formatTime(basis.value.confirmed_at) : null],
  ['knowledge.workspace.inspector.basis.agentPolicy', basis.value.agent_policy_version],
] : [])
function measureBody() {
  const el = bodyElement.value
  if (!el) return
  const height = parseFloat(getComputedStyle(el).lineHeight) || 24
  // Measure an unclamped copy. Reading the clamped element itself can report
  // its visible height, toggling the clamp on every ResizeObserver callback.
  const measure = el.cloneNode(true) as HTMLElement
  measure.classList.remove('is-preview')
  Object.assign(measure.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', width: `${el.getBoundingClientRect().width}px`, height: 'auto', maxHeight: 'none' })
  measure.setAttribute('aria-hidden', 'true')
  document.body.append(measure)
  longText.value = measure.scrollHeight > height * 8 + 1
  measure.remove()
}
let observer: ResizeObserver | undefined
let measureFrame: number | null = null
let disposed = false
function scheduleBodyMeasurement() {
  if (disposed || measureFrame !== null) return
  measureFrame = requestAnimationFrame(() => {
    measureFrame = null
    measureBody()
  })
}
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(scheduleBodyMeasurement)
    if (bodyElement.value) observer.observe(bodyElement.value)
  }
  measureBody()
})
onBeforeUnmount(() => {
  disposed = true
  observer?.disconnect()
  if (measureFrame !== null) cancelAnimationFrame(measureFrame)
})
watch(() => props.item.body, () => { fullText.value = false; void nextTick(scheduleBodyMeasurement) })
</script>
<template>
  <div class="preference-detail">
    <section class="preference-summary">
      <div class="preference-context">
        <span>{{ scopeLabel || t('preferences.detail.scopeUnknown') }}</span>
        <strong>{{ statusLabel || reviewStateLabel(item) }}</strong>
      </div>
      <p v-if="item.humanEdited" class="preference-risk">{{ humanChangeStatusLabel(item.humanChangeStatus) }}</p>
      <div v-if="item.invalidAt" class="preference-risk">
        <strong>{{ t('knowledge.workspace.inspector.historical') }}</strong>
        <Button variant="outline" v-if="replacement" @click="emit('openReplacement', replacement)">{{ t('knowledge.workspace.inspector.viewReplacement') }}</Button>
        <p v-else>{{ t(item.replacedByItemId ? 'knowledge.workspace.inspector.replacementOutOfScope' : 'knowledge.workspace.inspector.missingReplacement') }}</p>
      </div>
      <div v-if="editable && !managed" class="preference-actions">
        <Button v-if="canConfirm" class="inspector-confirm-action" @click="emit('confirm', item)">{{ t('knowledge.workspace.inspector.confirmPreference') }}</Button>
        <Button variant="outline" class="inspector-edit-action" @click="emit('edit', item)">{{ t('knowledge.workspace.inspector.correctPreference') }}</Button>
      </div>
      <p ref="bodyElement" class="preference-body" :class="{ 'is-preview': longText && !fullText }">{{ item.body }}</p>
      <Button v-if="longText" variant="ghost" :aria-expanded="fullText" @click="fullText = !fullText">{{ t(fullText ? 'preferences.detail.hideText' : 'preferences.detail.fullText') }}</Button>
    </section>
    <UiDisclosure :title="t('preferences.detail.basis')" data-preference-basis>
      <p>{{ classificationExplanation(item) }}</p>
      <dl v-if="basis" class="preference-basis">
        <div v-for="[key, value] in basisRows" :key="String(key)"><dt>{{ t(String(key)) }}</dt><dd>{{ value || t('preferences.detail.notRecorded') }}</dd></div>
      </dl>
      <p v-else>{{ t('knowledge.workspace.inspector.legacyBasis') }}</p>
      <p v-if="item.reasoningSummary && !basisRows.some(([, value]) => value === item.reasoningSummary)">{{ item.reasoningSummary }}</p>
      <dl class="preference-basis">
        <template v-if="showsAgentConfirmationProgress(item)">
          <div><dt>{{ t('knowledge.workspace.inspector.autoConfirmation.progressLabel') }}</dt><dd>{{ agentConfirmationProgressText(item) }}</dd></div>
          <div><dt>{{ t('knowledge.workspace.inspector.autoConfirmation.reasonLabel') }}</dt><dd>{{ agentConfirmationBlockingText(item) }}</dd></div>
        </template>
        <div><dt>{{ t('knowledge.workspace.inspector.fields.recentUse') }}</dt><dd>{{ item.lastUsedAt ? formatTime(item.lastUsedAt) : t('preferences.detail.notRecorded') }}</dd></div>
      </dl>
      <p v-if="item.humanEdited">{{ t(`knowledge.workspace.inspector.humanReview.${item.humanChangeStatus === 'unseen' ? 'unseen' : item.humanChangeStatus === 'viewed' ? 'viewed' : 'reviewed'}`) }} · {{ t('knowledge.workspace.inspector.humanVersion', { version: item.humanChangeVersion }) }}</p>
    </UiDisclosure>
    <!-- The evidence count lives in this one disclosure's title; no separate jump link. -->
    <UiDisclosure :title="t('preferences.detail.records', { count: item.evidence.length })" data-preference-records>
      <KnowledgeRecords :item="item" :conversation-launchers="conversationLaunchers" raw-fields />
      <template v-if="related.length"><h4>{{ t('preferences.detail.shownRelations') }}</h4><pre>{{ JSON.stringify(related, null, 2) }}</pre></template>
      <h4>{{ t('knowledge.workspace.inspector.technicalDetails') }}</h4>
      <pre data-raw-record>{{ JSON.stringify(item.raw, null, 2) }}</pre>
    </UiDisclosure>
  </div>
</template>
<style scoped>
.preference-detail { display: grid; min-width: 0; color: var(--color-ink); overflow-wrap: anywhere; }
/* The two disclosures sit flush, one hairline apart, and the last one ends the dialog without spare space. */
.preference-summary { margin-bottom: 16px; }
.preference-detail > .ui-disclosure { padding-block: 2px; }
.preference-detail > .ui-disclosure[open] { padding-bottom: 14px; }
.preference-summary { display: grid; gap: 12px; max-width: 760px; min-width: 0; font-size: 14px; }
.preference-context { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.preference-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; }
.preference-actions :deep(button) { min-height: 44px; white-space: normal; }
.preference-body { margin: 0; white-space: pre-wrap; line-height: 1.65; font-size: 16px; }
.preference-body.is-preview { display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
.preference-risk { margin: 0; color: var(--color-ink); font-weight: 600; }
.preference-risk p { font-weight: 400; }
.preference-basis { display: grid; gap: 12px; }
.preference-basis div { display: grid; grid-template-columns: minmax(100px, 160px) minmax(0, 1fr); gap: 8px; }
.preference-basis dd { margin: 0; white-space: pre-wrap; }
.preference-basis dt { color: var(--color-ink-soft); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
:deep(.evidence-excerpt) { max-height: none; white-space: pre-wrap; color: var(--color-ink); }
:deep(summary) { min-height: 44px; }
@media (max-width: 480px) { .preference-basis div { grid-template-columns: 1fr; gap: 4px; } }
</style>
