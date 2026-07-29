<script setup lang="ts">
import { computed } from 'vue'

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
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeItem, KnowledgeNode } from '@/types'

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
  managementItem.value && props.canManageProject,
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
    return '这次人工修改还没有被 Agent 调用查看，提醒会持续保留。'
  }
  if (item.humanChangeStatus === 'viewed') {
    return 'Agent 已查看当前版本，但还没有同时完成冲突检查和分类合理性审核。'
  }
  return 'Agent 已对当前人工修改版本完成无冲突与分类合理性审核；历史记录仍永久保留。'
})

function display(value: unknown) {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function percentage(value: number) {
  return `${Math.round(value * 100)}%`
}

function inheritanceLabel(item: KnowledgeItem) {
  if (item.inheritanceMode === 'descendants') return '允许子项目继承'
  if (item.inheritanceMode === 'selected_projects') {
    return `仅指定项目（${item.inheritedProjectIds.length}）`
  }
  return '仅当前项目'
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
          {{ managementItem ? '资料投影 ID' : item.itemKind === 'entity' ? '节点 ID' : '关系 ID' }}
        </span>
        <code>{{ item.id }}</code>
      </div>
      <p class="muted">{{ item.body }}</p>

      <section v-if="managementItem" class="inspector-project-material">
        <div>
          <span>内容归属</span>
          <strong>{{ projectMaterialTypeLabel(item) }}</strong>
        </div>
        <p>
          这是项目档案在关系图中的投影，不是可独立确认、失效或恢复的知识记录。
          如需改变内容，请编辑项目资料。
        </p>
      </section>

      <section v-else class="inspector-classification" :class="`state-${reviewState}`">
        <div>
          <span>当前判定</span>
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
          <span>人工变更审核</span>
          <strong>{{ humanChangeStatusLabel(item.humanChangeStatus) }}</strong>
        </div>
        <p>{{ humanAuditCopy }}</p>
        <small>人工变更版本 {{ item.humanChangeVersion }}</small>
      </section>

      <section v-if="!managementItem && item.invalidAt" class="inspector-replacement">
        <div class="inspector-replacement-heading">
          <span>替代关系</span>
          <strong>{{ replacementItem ? '已被以下内容取代' : '没有可跳转的替代内容' }}</strong>
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
          <b>查看替代内容 →</b>
        </button>
        <p v-else-if="item.replacedByItemId">
          已记录替代对象，但它不在当前查看范围内。
        </p>
        <p v-else>
          这条历史记录只有失效原因，没有记录明确的替代对象；系统不会根据文字猜测链接。
        </p>
      </section>

      <dl class="inspector-meta">
        <div><dt>类型</dt><dd>{{ item.type }}</dd></div>
        <div v-if="!managementItem"><dt>发现时象限</dt><dd>{{ quadrantLabel(item.originQuadrant) }}</dd></div>
        <div v-if="!managementItem"><dt>当前分类</dt><dd>{{ quadrantLabel(item.currentQuadrant) }}</dd></div>
        <div v-if="!managementItem"><dt>象限解释</dt><dd>{{ quadrantDescription(item.originQuadrant) }}</dd></div>
        <div v-if="!managementItem"><dt>确认状态</dt><dd>{{ reviewStateLabel(item) }}</dd></div>
        <div v-if="!managementItem"><dt>置信分</dt><dd>{{ percentage(item.confidenceScore) }}</dd></div>
        <div v-if="!managementItem"><dt>效用分</dt><dd>{{ percentage(item.utilityScore) }}</dd></div>
        <div v-if="!managementItem">
          <dt>有效使用</dt><dd>{{ item.qualifiedUseCount }} 次 / {{ item.distinctTaskCount }} 个任务</dd>
        </div>
        <div v-if="!managementItem"><dt>最近使用</dt><dd>{{ formatTime(item.lastUsedAt) }}</dd></div>
        <div v-if="!managementItem && !item.profileAspect">
          <dt>知识继承</dt><dd>{{ inheritanceLabel(item) }}</dd>
        </div>
        <div v-if="!managementItem && item.profileAspect">
          <dt>协作偏好</dt><dd>{{ profileAspectLabel(item.profileAspect) }}</dd>
        </div>
        <div v-if="!managementItem && item.profileAspect">
          <dt>生效范围</dt>
          <dd>{{ item.preferenceScope === 'project' ? '指定项目' : '个人全局' }}</dd>
        </div>
        <template v-if="rawEdge">
          <div><dt>来源</dt><dd>{{ names.get(endpointId(rawEdge.source)) ?? endpointId(rawEdge.source) }}</dd></div>
          <div><dt>目标</dt><dd>{{ names.get(endpointId(rawEdge.target)) ?? endpointId(rawEdge.target) }}</dd></div>
        </template>
        <div v-if="!managementItem"><dt>状态</dt><dd>{{ item.invalidAt ? '历史 · 已失效' : '当前有效' }}</dd></div>
      </dl>

      <template v-if="!managementItem">
        <h4 class="inspector-subtitle">确认依据</h4>
        <dl v-if="confirmationBasis" class="inspector-meta inspector-confirmation-basis">
          <div><dt>为什么会有</dt><dd>{{ confirmationBasis.existence_reason }}</dd></div>
          <div><dt>为什么属于该象限</dt><dd>{{ confirmationBasis.quadrant_reason }}</dd></div>
          <div><dt>提出者</dt><dd>{{ confirmationActorLabel(confirmationBasis.proposed_by) }}</dd></div>
          <div><dt>确认者</dt><dd>{{ confirmationActorLabel(confirmationBasis.confirmed_by) }}</dd></div>
          <div><dt>确认时间</dt><dd>{{ formatTime(confirmationBasis.confirmed_at) }}</dd></div>
          <div v-if="confirmationBasis.agent_policy_version">
            <dt>Agent 策略</dt><dd>{{ confirmationBasis.agent_policy_version }}</dd>
          </div>
        </dl>
        <p v-else class="inspector-reasoning">
          旧数据没有结构化的确认依据，因此已放入待确认，不会自动作为已确认知识使用。
        </p>
      </template>

      <template v-if="attributes.length">
        <h4 class="inspector-subtitle">内容详情</h4>
        <dl class="inspector-meta inspector-attributes">
          <div v-for="[key, value] in attributes" :key="key">
            <dt>{{ key }}</dt><dd>{{ display(value) }}</dd>
          </div>
        </dl>
      </template>

      <template v-if="item.reasoningSummary">
        <h4 class="inspector-subtitle">形成过程</h4>
        <p class="inspector-reasoning">{{ item.reasoningSummary }}</p>
      </template>

      <div v-if="hasActions" class="inspector-actions">
        <button
          v-if="canConfirm"
          class="primary-action inspector-confirm-action"
          type="button"
          @click="emit('confirm', item)"
        >
          {{ item.profileAspect ? '确认这条偏好' : '确认这条知识' }}
        </button>
        <button
          v-if="canManageProjectMaterial"
          class="primary-action"
          type="button"
          @click="emit('manageProject', item)"
        >
          编辑项目资料
        </button>
        <button
          v-if="mode === 'graph'"
          class="secondary-action"
          type="button"
          @click="emit('openDirectory', item)"
        >
          在内容目录中定位
        </button>
        <button
          v-if="mode === 'directory'"
          class="secondary-action"
          type="button"
          @click="emit('openGraph', item)"
        >
          在关系图中定位
        </button>
        <button
          v-if="projectItem && personalProjectId && personalProjectId !== currentProjectId"
          class="primary-action"
          type="button"
          @click="emit('openProject', personalProjectId)"
        >
          进入这个项目
        </button>
        <button
          v-if="projectItem && personalProjectId && canPublishProject"
          class="secondary-action"
          type="button"
          @click="emit('publishProject', personalProjectId)"
        >
          发布 / 同步到公共
        </button>
        <button
          v-if="canCreateProject"
          class="primary-action"
          type="button"
          @click="emit('createProject', item)"
        >
          基于此创建项目
        </button>
        <button
          v-if="canEdit"
          class="secondary-action inspector-edit-action"
          type="button"
          @click="emit('edit', item)"
        >
          {{ item.profileAspect ? '纠正这条偏好' : '纠正或调整归属' }}
        </button>
      </div>

      <template v-if="related.length">
        <h4 class="inspector-subtitle">关联关系</h4>
        <div class="inspector-relations">
          <div v-for="edge in related" :key="edge.id" class="inspector-relation">
            <strong class="relation-type">{{ edge.type }}</strong>
            <p class="relation-target">{{ edge.fact || '关系' }}</p>
          </div>
        </div>
      </template>

      <template v-if="item.evidence.length">
        <h4 class="inspector-subtitle">证据与来源</h4>
        <div class="inspector-evidence">
          <article v-for="(evidence, index) in item.evidence" :key="String(evidence.id ?? index)" class="evidence-card">
            <strong>{{ evidence.name || evidence.source_description || '来源记录' }}</strong>
            <p>{{ evidence.summary || evidence.source_description }}</p>
            <span>{{ evidence.source_kind || '来源' }} · {{ formatTime(evidence.reference_time || evidence.created_at) }}</span>
            <p v-if="evidence.source_excerpt" class="evidence-excerpt">{{ evidence.source_excerpt }}</p>
          </article>
        </div>
      </template>

      <template v-if="item.revisions.length">
        <h4 class="inspector-subtitle">修订历史</h4>
        <div class="inspector-history">
          <article v-for="(revision, index) in item.revisions" :key="String(revision.id ?? index)" class="history-row">
            <strong>{{ revisionActionLabel(revision.action as string | undefined) }}</strong>
            <p>{{ revision.reason ?? revision.summary ?? '未填写说明' }}</p>
            <span>{{ formatTime(revision.created_at as string | undefined) }}</span>
          </article>
        </div>
      </template>

      <template v-if="item.auditEvents.length">
        <h4 class="inspector-subtitle">人工与 Agent 记录</h4>
        <div class="inspector-history inspector-audit-history">
          <article
            v-for="event in item.auditEvents"
            :key="event.id"
            class="history-row"
          >
            <strong>{{ knowledgeAuditActionLabel(event.action) }}</strong>
            <p>{{ event.reason }}</p>
            <span>
              版本 {{ event.human_change_version }}
              · {{ formatTime(event.created_at) }}
            </span>
            <small v-if="event.action === 'agent_review'">
              冲突：{{ event.conflict_check === 'no_conflict' ? '无冲突' : '有冲突' }}
              · 分类：{{ event.classification_check === 'reasonable' ? '合理' : '需调整' }}
            </small>
          </article>
        </div>
      </template>
    </template>
    <template v-else>
      <p class="eyebrow">内容详情</p>
      <h3>选择一个节点或关系</h3>
      <p class="inspector-placeholder">点击后查看完整说明、来源证据和关联关系。</p>
    </template>
  </aside>
</template>
