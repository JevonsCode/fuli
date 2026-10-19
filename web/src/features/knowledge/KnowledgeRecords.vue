<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import type { ConversationLauncherConfiguration, EvidenceRecord, KnowledgeItem } from '@/types'
import { formatTime, revisionActionLabel, knowledgeAuditActionLabel } from './model'
import { copySourceSession, sourceApplicationLabel, sourceLinkForEvidence, sourceLauncherAppName } from './source-adapters'
import { useConversationLauncherConfiguration } from './conversation-launcher-settings'
const props = defineProps<{ item: KnowledgeItem; conversationLaunchers?: ConversationLauncherConfiguration; rawFields?: boolean }>()
const copiedEvidenceKey = ref('')
const copyError = ref('')
const stored = useConversationLauncherConfiguration()
const launchers = computed(() => props.conversationLaunchers ?? stored.value)
const conversationLink = (evidence: EvidenceRecord) => sourceLinkForEvidence(evidence, launchers.value)
const conversationAppName = (evidence: EvidenceRecord) => sourceLauncherAppName(evidence, launchers.value)
const evidenceKey = (evidence: EvidenceRecord, index: number) => `${index}:${evidence.id ?? evidence.session_id ?? ''}`
let copyVersion = 0
watch(() => props.item, () => { ++copyVersion; copiedEvidenceKey.value = ''; copyError.value = '' })
async function copyEvidenceSession(evidence: EvidenceRecord, index: number) {
  const version = ++copyVersion
  copyError.value = ''
  try {
    const copied = await copySourceSession(evidence)
    if (version !== copyVersion) return
    if (copied) copiedEvidenceKey.value = evidenceKey(evidence, index)
    else copyError.value = t('preferences.detail.copyFailed')
  } catch { if (version === copyVersion) copyError.value = t('preferences.detail.copyFailed') }
}
</script>
<template>
      <template v-if="item.evidence.length">
        <h4 class="inspector-subtitle">{{ t('knowledge.workspace.inspector.evidence') }}</h4>
        <div class="inspector-evidence">
          <article
            v-for="(evidence, index) in item.evidence"
            :key="evidenceKey(evidence, index)"
            class="evidence-card"
          >
            <strong>{{ evidence.name || evidence.source_description || t('knowledge.workspace.inspector.sourceRecord') }}</strong>
            <p>{{ evidence.summary || evidence.source_description }}</p>
            <p v-if="rawFields && evidence.summary && evidence.source_description && evidence.summary !== evidence.source_description">{{ evidence.source_description }}</p>
            <span>
              {{ sourceApplicationLabel(evidence) }}
              · {{ evidence.source_kind || t('knowledge.workspace.inspector.source') }}
              · {{ formatTime(evidence.reference_time || evidence.created_at) }}
            </span>
            <p v-if="evidence.source_excerpt" class="evidence-excerpt">{{ evidence.source_excerpt }}</p>
            <div v-if="evidence.session_id" class="evidence-source-actions">
              <Button variant="outline" class="evidence-source-action" :aria-label="copiedEvidenceKey === evidenceKey(evidence, index) ? t('knowledge.workspace.inspector.copiedSessionId') : t('knowledge.workspace.inspector.copySessionId')" @click="copyEvidenceSession(evidence, index)"><span v-if="!rawFields">{{ copiedEvidenceKey === evidenceKey(evidence, index) ? t('knowledge.workspace.inspector.copiedSessionId') : t('knowledge.workspace.inspector.copySessionId') }}</span><svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg></Button>
              <span v-if="rawFields && copiedEvidenceKey === evidenceKey(evidence, index)" role="status">{{ t('knowledge.workspace.inspector.copiedSessionId') }}</span>
              <a
                v-if="conversationLink(evidence)"
                class="evidence-source-action"
                :href="conversationLink(evidence) ?? undefined"
                :title="t('knowledge.workspace.inspector.openConversationWith', {
                  app: conversationAppName(evidence) ?? sourceApplicationLabel(evidence),
                })"
              >
                {{ t('knowledge.workspace.inspector.openConversation') }}
              </a>
            </div>
            <pre v-if="rawFields">{{ JSON.stringify(evidence, null, 2) }}</pre>
          </article>
        </div>
      </template>

      <template v-if="item.revisions.length">
        <h4 class="inspector-subtitle">{{ t('knowledge.workspace.inspector.revisions') }}</h4>
        <div class="inspector-history">
          <article v-for="(revision, index) in item.revisions" :key="String(revision.id ?? index)" class="history-row">
            <strong>{{ revisionActionLabel(revision.action as string | undefined) }}</strong>
            <p>{{ revision.reason ?? revision.summary ?? t('knowledge.workspace.inspector.noRevisionCopy') }}</p>
            <span>{{ formatTime(revision.created_at as string | undefined) }}</span>
          </article>
        </div>
      </template>

      <template v-if="item.auditEvents.length">
        <h4 class="inspector-subtitle">{{ t('knowledge.workspace.inspector.audit') }}</h4>
        <div class="inspector-history inspector-audit-history">
          <article
            v-for="event in item.auditEvents"
            :key="event.id"
            class="history-row"
          >
            <strong>{{ knowledgeAuditActionLabel(event.action) }}</strong>
            <p>{{ event.reason }}</p>
            <span>
              {{ t('knowledge.workspace.inspector.version', { version: event.human_change_version }) }}
              · {{ formatTime(event.created_at) }}
            </span>
            <small v-if="event.action === 'agent_review'">
              {{ t('knowledge.workspace.inspector.conflictClassification', {
                conflict: event.conflict_check === 'no_conflict'
                  ? t('knowledge.workspace.inspector.conflictNone')
                  : t('knowledge.workspace.inspector.conflictFound'),
                classification: event.classification_check === 'reasonable'
                  ? t('knowledge.workspace.inspector.classificationReasonable')
                  : t('knowledge.workspace.inspector.classificationAdjust'),
              }) }}
            </small>
          </article>
        </div>
      </template>
<p v-if="copyError" role="status">{{ copyError }}</p>
</template>
<style scoped>
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.evidence-source-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>
