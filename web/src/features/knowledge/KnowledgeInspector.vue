<script setup lang="ts">
import { computed, ref } from 'vue'

import { t } from '@/i18n'
import {
  classificationExplanation,
  confirmationActorLabel,
  endpointId,
  formatTime,
  humanChangeStatusLabel,
  isManagementKnowledgeItem,
  knowledgeItems,
  knowledgeAuditActionLabel,
  knowledgeReviewState,
  personalProjectIdForItem,
  profileAspectLabel,
  projectMaterialTypeLabel,
  quadrantDescription,
  quadrantLabel,
  revisionActionLabel,
  reviewStateLabel,
} from './model'
import {
  copySourceSession,
  sourceApplicationLabel,
  sourceLinkForEvidence,
} from './source-adapters'
import type {
  EvidenceRecord,
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeItem,
  KnowledgeNode,
} from '@/types'

const props = defineProps<{
  item: KnowledgeItem | null
  graph: KnowledgeGraph | null
  editable?: boolean
  currentProjectId?: string | null
  canPublishProject?: boolean
  canManageProject?: boolean
  mode?: 'directory' | 'graph'
}>()

const emit = defineEmits<{
  confirm: [item: KnowledgeItem]
  edit: [item: KnowledgeItem]
  createProject: [item: KnowledgeItem]
  openProject: [projectId: string]
  publishProject: [projectId: string]
  openDirectory: [item: KnowledgeItem]
  openGraph: [item: KnowledgeItem]
  openReplacement: [item: KnowledgeItem]
  manageProject: [item: KnowledgeItem]
}>()

const rawNode = computed(() =>
  props.item?.itemKind === 'entity' ? (props.item.raw as KnowledgeNode) : null,
)
const rawEdge = computed(() =>
  props.item?.itemKind === 'relationship' ? (props.item.raw as KnowledgeEdge) : null,
)
const names = computed(
  () => new Map(props.graph?.nodes.map((node) => [node.id, node.name]) ?? []),
)
const related = computed(() => {
  if (!rawNode.value || !props.graph) return []
  return props.graph.edges
    .filter(
      (edge) =>
        endpointId(edge.source) === rawNode.value?.id
        || endpointId(edge.target) === rawNode.value?.id,
    )
    .slice(0, 12)
})
const attributes = computed(() =>
  Object.entries((props.item?.raw.attributes as Record<string, unknown> | undefined) ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== ''),
)
const managementItem = computed(() => isManagementKnowledgeItem(props.item))
const personalProjectId = computed(() => personalProjectIdForItem(props.item))
const projectItem = computed(() =>
  props.item?.itemKind === 'entity'
  && ['PersonalProject', 'RelatedPersonalProject'].includes(props.item.type),
)
const canCreateProject = computed(() =>
  props.editable
  && props.item?.itemKind === 'entity'
  && !props.item.invalidAt
  && !props.item.profileAspect
  && !managementItem.value,
)
const canEdit = computed(() => props.editable && !managementItem.value)
const canConfirm = computed(() =>
  props.editable
  && !managementItem.value
  && !props.item?.invalidAt
  && Boolean(props.item?.classificationExplicit)
  && reviewState.value === 'pending',
)
const canManageProjectMaterial = computed(() =>
  managementItem.value
  && props.canManageProject
  && props.item?.type !== 'ExternalKnowledgeSource',
)
const hasActions = computed(() =>
  canCreateProject.value
  || canEdit.value
  || canConfirm.value
  || canManageProjectMaterial.value
  || Boolean(props.mode)
  || (
    projectItem.value
    && Boolean(personalProjectId.value)
    && personalProjectId.value !== props.currentProjectId
  )
  || (projectItem.value && Boolean(personalProjectId.value) && props.canPublishProject),
)
const reviewState = computed(() =>
  props.item ? knowledgeReviewState(props.item) : 'unclassified',
)
const classificationCopy = computed(() =>
  props.item ? classificationExplanation(props.item) : '',
)
const confirmationBasis = computed(() => props.item?.confirmationBasis ?? null)
const copiedEvidenceKey = ref('')
const replacementItem = computed(() => {
  const itemId = props.item?.replacedByItemId
  const itemKind = props.item?.replacedByItemKind
  if (!itemId || !itemKind) return null
  return knowledgeItems(props.graph).find(
    (candidate) => candidate.id === itemId && candidate.itemKind === itemKind,
  ) ?? null
})
const humanAuditCopy = computed(() => {
  const item = props.item
  if (!item?.humanEdited) return ''
  if (item.humanChangeStatus === 'unseen') {
    return t('knowledge.workspace.inspector.humanReview.unseen')
  }
  if (item.humanChangeStatus === 'viewed') {
    return t('knowledge.workspace.inspector.humanReview.viewed')
  }
  return t('knowledge.workspace.inspector.humanReview.reviewed')
})

function display(value: unknown) {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function percentage(value: number) {
  return `${Math.round(value * 100)}%`
}

function inheritanceLabel(item: KnowledgeItem) {
  if (item.inheritanceMode === 'descendants') {
    return t('knowledge.workspace.inspector.inheritance.descendants')
  }
  if (item.inheritanceMode === 'selected_projects') {
    return t('knowledge.workspace.inspector.inheritance.selected', {
      count: item.inheritedProjectIds.length,
    })
  }
  return t('knowledge.workspace.inspector.inheritance.local')
}

function evidenceKey(evidence: EvidenceRecord, index: number) {
  return String(evidence.id ?? evidence.session_id ?? index)
}

async function copyEvidenceSession(evidence: EvidenceRecord, index: number) {
  if (!await copySourceSession(evidence)) return
  copiedEvidenceKey.value = evidenceKey(evidence, index)
}
</script>

<template>
  <aside class="graph-inspector">
    <template v-if="item">
      <p class="eyebrow">
        {{ managementItem ? 'PROJECT MATERIAL' : item.itemKind === 'entity' ? 'ENTITY' : 'RELATIONSHIP' }}
      </p>
      <h3>{{ item.itemKind === 'entity' ? item.title : rawEdge?.type }}</h3>
      <div class="inspector-identity">
        <span>
          {{ managementItem
            ? t('knowledge.workspace.inspector.ids.projection')
            : item.itemKind === 'entity'
              ? t('knowledge.workspace.inspector.ids.node')
              : t('knowledge.workspace.inspector.ids.relationship') }}
        </span>
        <code>{{ item.id }}</code>
      </div>
      <p class="muted">{{ item.body }}</p>

      <section v-if="managementItem" class="inspector-project-material">
        <div>
          <span>{{ t('knowledge.workspace.inspector.ownership') }}</span>
          <strong>{{ projectMaterialTypeLabel(item) }}</strong>
        </div>
        <p>{{ t('knowledge.workspace.inspector.projectionCopy') }}</p>
      </section>

      <section v-else class="inspector-classification" :class="`state-${reviewState}`">
        <div>
          <span>{{ t('knowledge.workspace.inspector.currentJudgment') }}</span>
          <strong>{{ reviewStateLabel(item) }}</strong>
        </div>
        <p>{{ classificationCopy }}</p>
      </section>

      <section
        v-if="!managementItem && item.humanEdited"
        class="inspector-human-change"
        :class="`state-${item.humanChangeStatus}`"
      >
        <div>
          <span>{{ t('knowledge.workspace.inspector.humanReviewTitle') }}</span>
          <strong>{{ humanChangeStatusLabel(item.humanChangeStatus) }}</strong>
        </div>
        <p>{{ humanAuditCopy }}</p>
        <small>{{ t('knowledge.workspace.inspector.humanVersion', { version: item.humanChangeVersion }) }}</small>
      </section>

      <section v-if="!managementItem && item.invalidAt" class="inspector-replacement">
        <div class="inspector-replacement-heading">
          <span>{{ t('knowledge.workspace.inspector.replacement') }}</span>
          <strong>{{ replacementItem
            ? t('knowledge.workspace.inspector.replacedBy')
            : t('knowledge.workspace.inspector.noReplacement') }}</strong>
        </div>
        <button
          v-if="replacementItem"
          class="inspector-replacement-link"
          type="button"
          @click="emit('openReplacement', replacementItem)"
        >
          <span>
            <strong>{{ replacementItem.title }}</strong>
            <small>{{ replacementItem.body }}</small>
          </span>
          <b>{{ t('knowledge.workspace.inspector.viewReplacement') }}</b>
        </button>
        <p v-else-if="item.replacedByItemId">
          {{ t('knowledge.workspace.inspector.replacementOutOfScope') }}
        </p>
        <p v-else>
          {{ t('knowledge.workspace.inspector.missingReplacement') }}
        </p>
      </section>

      <dl class="inspector-meta">
        <div><dt>{{ t('knowledge.workspace.inspector.fields.type') }}</dt><dd>{{ item.type }}</dd></div>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.originQuadrant') }}</dt><dd>{{ quadrantLabel(item.originQuadrant) }}</dd></div>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.currentQuadrant') }}</dt><dd>{{ quadrantLabel(item.currentQuadrant) }}</dd></div>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.quadrantExplanation') }}</dt><dd>{{ quadrantDescription(item.originQuadrant) }}</dd></div>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.confirmationStatus') }}</dt><dd>{{ reviewStateLabel(item) }}</dd></div>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.confidence') }}</dt><dd>{{ percentage(item.confidenceScore) }}</dd></div>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.utility') }}</dt><dd>{{ percentage(item.utilityScore) }}</dd></div>
        <div v-if="!managementItem">
          <dt>{{ t('knowledge.workspace.inspector.fields.materialUse') }}</dt><dd>{{ t('knowledge.workspace.inspector.useCount', {
            uses: item.qualifiedUseCount,
            tasks: item.distinctTaskCount,
          }) }}</dd>
        </div>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.recentUse') }}</dt><dd>{{ formatTime(item.lastUsedAt) }}</dd></div>
        <div v-if="!managementItem && !item.profileAspect">
          <dt>{{ t('knowledge.workspace.inspector.fields.inheritance') }}</dt><dd>{{ inheritanceLabel(item) }}</dd>
        </div>
        <div v-if="!managementItem && item.profileAspect">
          <dt>{{ t('knowledge.workspace.inspector.fields.preference') }}</dt><dd>{{ profileAspectLabel(item.profileAspect) }}</dd>
        </div>
        <div v-if="!managementItem && item.profileAspect">
          <dt>{{ t('knowledge.workspace.inspector.fields.effectiveScope') }}</dt>
          <dd>{{ item.preferenceScope === 'project'
            ? t('knowledge.workspace.inspector.selectedProject')
            : t('knowledge.workspace.inspector.personalGlobal') }}</dd>
        </div>
        <template v-if="rawEdge">
          <div><dt>{{ t('knowledge.workspace.inspector.fields.source') }}</dt><dd>{{ names.get(endpointId(rawEdge.source)) ?? rawEdge.source_name ?? endpointId(rawEdge.source) }}</dd></div>
          <div><dt>{{ t('knowledge.workspace.inspector.fields.target') }}</dt><dd>{{ names.get(endpointId(rawEdge.target)) ?? rawEdge.target_name ?? endpointId(rawEdge.target) }}</dd></div>
        </template>
        <div v-if="!managementItem"><dt>{{ t('knowledge.workspace.inspector.fields.status') }}</dt><dd>{{ item.invalidAt
          ? t('knowledge.workspace.inspector.historical')
          : t('common.status.current') }}</dd></div>
      </dl>

      <template v-if="!managementItem">
        <h4 class="inspector-subtitle">{{ t('knowledge.workspace.inspector.basisTitle') }}</h4>
        <dl v-if="confirmationBasis" class="inspector-meta inspector-confirmation-basis">
          <div><dt>{{ t('knowledge.workspace.inspector.basis.existence') }}</dt><dd>{{ confirmationBasis.existence_reason }}</dd></div>
          <div><dt>{{ t('knowledge.workspace.inspector.basis.quadrant') }}</dt><dd>{{ confirmationBasis.quadrant_reason }}</dd></div>
          <div><dt>{{ t('knowledge.workspace.inspector.basis.proposer') }}</dt><dd>{{ confirmationActorLabel(confirmationBasis.proposed_by) }}</dd></div>
          <div><dt>{{ t('knowledge.workspace.inspector.basis.confirmer') }}</dt><dd>{{ confirmationActorLabel(confirmationBasis.confirmed_by) }}</dd></div>
          <div><dt>{{ t('knowledge.workspace.inspector.basis.time') }}</dt><dd>{{ formatTime(confirmationBasis.confirmed_at) }}</dd></div>
          <div v-if="confirmationBasis.agent_policy_version">
            <dt>{{ t('knowledge.workspace.inspector.basis.agentPolicy') }}</dt><dd>{{ confirmationBasis.agent_policy_version }}</dd>
          </div>
        </dl>
        <p v-else class="inspector-reasoning">{{ t('knowledge.workspace.inspector.legacyBasis') }}</p>
      </template>

      <template v-if="attributes.length">
        <h4 class="inspector-subtitle">{{ t('knowledge.workspace.inspector.contentDetails') }}</h4>
        <dl class="inspector-meta inspector-attributes">
          <div v-for="[key, value] in attributes" :key="key">
            <dt>{{ key }}</dt><dd>{{ display(value) }}</dd>
          </div>
        </dl>
      </template>

      <template v-if="item.reasoningSummary">
        <h4 class="inspector-subtitle">{{ t('knowledge.workspace.inspector.formation') }}</h4>
        <p class="inspector-reasoning">{{ item.reasoningSummary }}</p>
      </template>

      <div v-if="hasActions" class="inspector-actions">
        <button
          v-if="canConfirm"
          class="primary-action inspector-confirm-action"
          type="button"
          @click="emit('confirm', item)"
        >
          {{ item.profileAspect
            ? t('knowledge.workspace.inspector.confirmPreference')
            : t('knowledge.workspace.inspector.confirmKnowledge') }}
        </button>
        <button
          v-if="canManageProjectMaterial"
          class="primary-action"
          type="button"
          @click="emit('manageProject', item)"
        >
          {{ t('knowledge.workspace.inspector.editMaterials') }}
        </button>
        <button
          v-if="mode === 'graph'"
          class="secondary-action"
          type="button"
          @click="emit('openDirectory', item)"
        >
          {{ t('knowledge.workspace.inspector.locateDirectory') }}
        </button>
        <button
          v-if="mode === 'directory'"
          class="secondary-action"
          type="button"
          @click="emit('openGraph', item)"
        >
          {{ t('knowledge.workspace.inspector.locateGraph') }}
        </button>
        <button
          v-if="projectItem && personalProjectId && personalProjectId !== currentProjectId"
          class="primary-action"
          type="button"
          @click="emit('openProject', personalProjectId)"
        >
          {{ t('knowledge.workspace.inspector.enterProject') }}
        </button>
        <button
          v-if="projectItem && personalProjectId && canPublishProject"
          class="secondary-action"
          type="button"
          @click="emit('publishProject', personalProjectId)"
        >
          {{ t('knowledge.workspace.inspector.publish') }}
        </button>
        <button
          v-if="canCreateProject"
          class="primary-action"
          type="button"
          @click="emit('createProject', item)"
        >
          {{ t('knowledge.workspace.inspector.createProject') }}
        </button>
        <button
          v-if="canEdit"
          class="secondary-action inspector-edit-action"
          type="button"
          @click="emit('edit', item)"
        >
          {{ item.profileAspect
            ? t('knowledge.workspace.inspector.correctPreference')
            : t('knowledge.workspace.inspector.correctOrAssign') }}
        </button>
      </div>

      <template v-if="related.length">
        <h4 class="inspector-subtitle">{{ t('knowledge.workspace.inspector.relations') }}</h4>
        <div class="inspector-relations">
          <div v-for="edge in related" :key="edge.id" class="inspector-relation">
            <strong class="relation-type">{{ edge.type }}</strong>
            <p class="relation-target">{{ edge.fact || t('knowledge.workspace.inspector.relationshipFallback') }}</p>
          </div>
        </div>
      </template>

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
            <span>
              {{ sourceApplicationLabel(evidence) }}
              · {{ evidence.source_kind || t('knowledge.workspace.inspector.source') }}
              · {{ formatTime(evidence.reference_time || evidence.created_at) }}
            </span>
            <p v-if="evidence.source_excerpt" class="evidence-excerpt">{{ evidence.source_excerpt }}</p>
            <a
              v-if="sourceLinkForEvidence(evidence)"
              class="evidence-source-action"
              :href="sourceLinkForEvidence(evidence) ?? undefined"
            >
              {{ t('knowledge.workspace.inspector.openConversation') }}
            </a>
            <button
              v-else-if="evidence.session_id"
              class="evidence-source-action"
              type="button"
              @click="copyEvidenceSession(evidence, index)"
            >
              {{
                copiedEvidenceKey === evidenceKey(evidence, index)
                  ? t('knowledge.workspace.inspector.copiedSessionId')
                  : t('knowledge.workspace.inspector.copySessionId')
              }}
            </button>
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
    </template>
    <template v-else>
      <p class="eyebrow">{{ t('knowledge.workspace.inspector.contentDetails') }}</p>
      <h3>{{ t('knowledge.workspace.inspector.placeholderTitle') }}</h3>
      <p class="inspector-placeholder">{{ t('knowledge.workspace.inspector.placeholderCopy') }}</p>
    </template>
  </aside>
</template>
