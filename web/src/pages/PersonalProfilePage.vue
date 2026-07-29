<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { getJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import KnowledgeConfirmDialog from '@/features/knowledge/KnowledgeConfirmDialog.vue'
import KnowledgeInspector from '@/features/knowledge/KnowledgeInspector.vue'
import KnowledgeEditDialog from '@/features/knowledge/KnowledgeEditDialog.vue'
import PreferenceConflictDialog from '@/features/preferences/PreferenceConflictDialog.vue'
import {
  detectPreferenceConflicts,
  preferenceConflictRecordItemIds,
  preferenceValue,
  type PreferenceConflict,
  type PreferenceConflictRecord,
} from '@/features/preferences/preference-conflicts'
import {
  formatTime,
  knowledgeReviewState,
  latestItemValue,
  personalProfileItems,
  profileAspectLabel,
  quadrantLabel,
  reviewStateLabel,
  type KnowledgeReviewState,
} from '@/features/knowledge/model'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeGraph, KnowledgeItem } from '@/types'

const store = useConsoleStore()
const graph = ref<KnowledgeGraph | null>(null)
const loading = ref(false)
const activeAspect = ref('all')
const activeScope = ref('all')
const activeReviewState = ref<'all' | KnowledgeReviewState>('all')
const conflictsOnly = ref(false)
const selectedItem = ref<KnowledgeItem | null>(null)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const activeConflict = ref<PreferenceConflict | null>(null)
const conflictRecords = ref<PreferenceConflictRecord[]>([])
const deferringConflictId = ref('')

const items = computed(() => personalProfileItems(graph.value))
const conflicts = computed(() =>
  detectPreferenceConflicts(items.value, conflictRecords.value),
)
const conflictingIds = computed(
  () => new Set(conflicts.value.flatMap(({ left, right }) => [left.id, right.id])),
)
const aiResolvedIds = computed(
  () => new Set(
    conflictRecords.value
      .filter(
        ({ status, resolved_by: resolvedBy }) =>
          status === 'resolved' && resolvedBy === 'agent',
      )
      .flatMap(preferenceConflictRecordItemIds),
  ),
)
const visibleItems = computed(() =>
  items.value.filter(
    (item) =>
      matchesActiveFilters(item)
      && (
        activeReviewState.value === 'all'
        || knowledgeReviewState(item) === activeReviewState.value
      ),
  ),
)
const visibleConflicts = computed(() =>
  conflicts.value.filter(
    ({ left, right }) => matchesActiveFilters(left) || matchesActiveFilters(right),
  ),
)
const scopeOptions = computed(() => {
  const projectNames = new Map(
    (store.state?.personalProjects ?? []).map(
      (project) => [project.project_id, project.profile.name],
    ),
  )
  const projectIds = [
    ...new Set(
      items.value
        .filter(
          ({ preferenceScope, preferenceProjectId }) =>
            preferenceScope === 'project' && Boolean(preferenceProjectId),
        )
        .map(({ preferenceProjectId }) => preferenceProjectId as string),
    ),
  ].sort((left, right) =>
    (projectNames.get(left) ?? left).localeCompare(
      projectNames.get(right) ?? right,
      'zh-CN',
    ),
  )
  return [
    { value: 'all', label: '全部范围', meta: `${items.value.length} 条` },
    {
      value: 'global',
      label: '个人全局',
      meta: `${
        items.value.filter(({ preferenceScope }) => preferenceScope !== 'project').length
      } 条`,
    },
    ...projectIds.map((projectId) => ({
      value: `project:${projectId}`,
      label: projectNames.get(projectId) ?? projectId,
      meta: `${
        items.value.filter(
          ({ preferenceScope, preferenceProjectId }) =>
            preferenceScope === 'project'
            && preferenceProjectId === projectId,
        ).length
      } 条项目偏好`,
      search: projectId,
    })),
  ]
})
const confirmedCount = computed(
  () => items.value.filter((item) => knowledgeReviewState(item) === 'confirmed').length,
)
const observedCount = computed(
  () => items.value.filter((item) => knowledgeReviewState(item) === 'pending').length,
)
const agentConfirmedCount = computed(
  () => items.value.filter(
    (item) => knowledgeReviewState(item) === 'agent_confirmed',
  ).length,
)
const summaryGuidance = computed(() => {
  if (conflictsOnly.value) {
    return '正在成对查看疑似冲突；再次点击可返回全部偏好。'
  }
  if (activeReviewState.value === 'pending') {
    return '已筛出待确认偏好。点击条目核对依据，再选择确认、纠正或标记失效。'
  }
  if (activeReviewState.value === 'confirmed') {
    return '已筛出确认人和确认时间完整的偏好；再次点击可返回全部偏好。'
  }
  if (activeReviewState.value === 'agent_confirmed') {
    return '已筛出由实际使用证据形成的 Agent 已确认偏好；它们仍低于人工确认。'
  }
  return '点击状态数字可筛选内容；疑似冲突会进入成对处理工作台。'
})

watch(
  () => store.activePersonalSpace?.id,
  (spaceId) => {
    if (spaceId) void load(spaceId)
  },
  { immediate: true },
)
watch(
  [activeAspect, activeScope, activeReviewState, conflictsOnly],
  () => {
    if (
      selectedItem.value
      && !visibleItems.value.some(({ id }) => id === selectedItem.value?.id)
    ) {
      selectedItem.value = null
    }
  },
)
watch(scopeOptions, (options) => {
  if (!options.some(({ value }) => value === activeScope.value)) activeScope.value = 'all'
})

async function load(spaceId = store.activePersonalSpace?.id) {
  if (!spaceId) return
  loading.value = true
  try {
    const query = new URLSearchParams({ spaceId, limit: '500' })
    const conflictQuery = new URLSearchParams({
      personalSpaceId: spaceId,
      limit: '500',
    })
    const [nextGraph, nextConflictRecords] = await Promise.all([
      getJson<KnowledgeGraph>(`/api/graph?${query}`),
      getJson<PreferenceConflictRecord[]>(
        `/api/preference-conflicts?${conflictQuery}`,
      ),
    ])
    graph.value = nextGraph
    conflictRecords.value = Array.isArray(nextConflictRecords)
      ? nextConflictRecords
      : []
    if (selectedItem.value) {
      selectedItem.value = items.value.find(({ id }) => id === selectedItem.value?.id) ?? null
    }
  } catch (error) {
    graph.value = null
    store.reportError(error)
  } finally {
    loading.value = false
  }
}

function statusLabel(item: KnowledgeItem) {
  const label = reviewStateLabel(item)
  const conflict = conflicts.value.find(
    ({ left, right }) => left.id === item.id || right.id === item.id,
  )
  if (conflict?.aiRecord) return `${label} · 待 AI 使用时判断`
  if (conflict) return `${label} · 疑似冲突`
  if (aiResolvedIds.value.has(item.id)) return `${label} · 曾冲突 / AI 已处理`
  return label
}

function scopeLabel(item: KnowledgeItem) {
  if (item.preferenceScope !== 'project' || !item.preferenceProjectId) return '个人全局'
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === item.preferenceProjectId,
  )
  return `仅 ${project?.profile.name ?? item.preferenceProjectId}`
}

function matchesActiveFilters(item: KnowledgeItem) {
  if (activeAspect.value !== 'all' && item.profileAspect !== activeAspect.value) return false
  if (activeScope.value === 'global' && item.preferenceScope === 'project') return false
  if (activeScope.value.startsWith('project:')) {
    const projectId = activeScope.value.slice('project:'.length)
    return item.preferenceScope === 'project' && item.preferenceProjectId === projectId
  }
  return true
}

function conflictScopeLabel(conflict: PreferenceConflict) {
  if (conflict.scopeKey === 'global') return '个人全局'
  const projectId = conflict.scopeKey.slice('project:'.length)
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === projectId,
  )
  return `仅 ${project?.profile.name ?? projectId}`
}

function openReplacement(item: KnowledgeItem) {
  activeAspect.value = item.profileAspect ?? 'all'
  activeScope.value = item.preferenceScope === 'project' && item.preferenceProjectId
    ? `project:${item.preferenceProjectId}`
    : 'global'
  conflictsOnly.value = false
  selectedItem.value = item
}

function editConflictItem(item: KnowledgeItem) {
  activeConflict.value = null
  editingItem.value = item
}

function toggleReviewState(state: KnowledgeReviewState) {
  const nextState = !conflictsOnly.value && activeReviewState.value === state
    ? 'all'
    : state
  conflictsOnly.value = false
  activeReviewState.value = nextState
  if (nextState !== 'all') {
    selectedItem.value = visibleItems.value.at(0) ?? null
  }
}

function toggleConflictWorkbench(forceOpen = false) {
  const nextState = forceOpen || !conflictsOnly.value
  conflictsOnly.value = nextState
  if (nextState) {
    activeReviewState.value = 'all'
    selectedItem.value = null
  }
}

async function deferConflictToAi(conflict: PreferenceConflict) {
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId || conflict.aiRecord) return
  deferringConflictId.value = conflict.id
  try {
    const record = await postJson<PreferenceConflictRecord>(
      '/api/preference-conflicts/defer',
      {
        personalSpaceId,
        conflictId: conflict.id,
        preferenceKey: conflict.preferenceKey,
        preferenceScope: conflict.left.preferenceScope ?? 'global',
        preferenceProjectId: conflict.left.preferenceProjectId,
        leftItemId: conflict.left.id,
        leftItemKind: conflict.left.itemKind,
        rightItemId: conflict.right.id,
        rightItemKind: conflict.right.itemKind,
        reason: '用户选择交给 AI，在首次相关使用前判断并处理。',
      },
    )
    conflictRecords.value = [
      record,
      ...conflictRecords.value.filter(({ id }) => id !== record.id),
    ]
    store.notify('已交给 AI：只有后续任务实际用到这组内容时，Agent 才会先判断并处理。')
  } catch (error) {
    store.reportError(error)
  } finally {
    deferringConflictId.value = ''
  }
}
</script>

<template>
  <section class="view vue-personal-profile">
    <div class="personal-profile-summary" aria-label="协作偏好状态">
      <button
        type="button"
        class="profile-summary-action state-confirmed"
        :aria-label="`查看 ${confirmedCount} 条已确认偏好`"
        :aria-pressed="!conflictsOnly && activeReviewState === 'confirmed'"
        @click="toggleReviewState('confirmed')"
      >
        <strong>{{ confirmedCount }}</strong>已确认
        <small>查看记录</small>
      </button>
      <button
        type="button"
        class="profile-summary-action state-agent-confirmed"
        :aria-label="`查看 ${agentConfirmedCount} 条 Agent 已确认偏好`"
        :aria-pressed="!conflictsOnly && activeReviewState === 'agent_confirmed'"
        @click="toggleReviewState('agent_confirmed')"
      >
        <strong>{{ agentConfirmedCount }}</strong>Agent 已确认
        <small>低于人工确认</small>
      </button>
      <button
        type="button"
        class="profile-summary-action state-pending"
        :aria-label="`查看并处理 ${observedCount} 条待确认偏好`"
        :aria-pressed="!conflictsOnly && activeReviewState === 'pending'"
        @click="toggleReviewState('pending')"
      >
        <strong>{{ observedCount }}</strong>待确认
        <small v-if="observedCount">查看并确认</small>
        <small v-else>查看记录</small>
      </button>
      <button
        type="button"
        class="profile-summary-action state-conflict"
        :aria-label="conflicts.length
          ? `查看并处理 ${conflicts.length} 组疑似冲突`
          : '当前没有疑似冲突'"
        :aria-pressed="conflictsOnly"
        @click="toggleConflictWorkbench()"
      >
        <strong>{{ conflicts.length }}</strong>疑似冲突
        <small>{{ conflicts.length ? '查看并处理' : '查看记录' }}</small>
      </button>
      <p>{{ summaryGuidance }}</p>
    </div>

    <section
      v-if="conflicts.length && !conflictsOnly && activeReviewState === 'all'"
      class="preference-conflict-alert"
      aria-label="待处理的疑似冲突"
    >
      <div class="preference-conflict-alert-icon" aria-hidden="true">!</div>
      <div>
        <span>需要你判断</span>
        <h2>发现 {{ conflicts.length }} 组疑似冲突</h2>
        <p>你可以现在人工处理，也可以交给 AI，等后续任务真正用到相关内容时再先判断、处理并留下审计标记。</p>
      </div>
      <button class="primary-action" type="button" @click="toggleConflictWorkbench(true)">
        查看冲突双方并处理
      </button>
    </section>

    <div class="personal-profile-toolbar">
      <div class="personal-profile-filter-groups">
        <div class="personal-profile-filters" role="group" aria-label="协作偏好维度">
          <button
            v-for="[value, label] in [['all', '全部'], ['taste', '品味'], ['personality', '个性'], ['judgment_preference', '判断偏好']]"
            :key="value"
            type="button"
            :aria-pressed="activeAspect === value"
            @click="activeAspect = value"
          >
            {{ label }}
          </button>
        </div>
        <SearchableSelect
          v-model="activeScope"
          class="personal-profile-scope-filter"
          control-id="personal-profile-scope"
          label="协作偏好生效范围"
          :options="scopeOptions"
          search-placeholder="搜索项目名称或 ID"
        />
      </div>
      <div class="personal-profile-toolbar-actions">
        <span v-if="conflictsOnly" class="muted">
          显示 {{ visibleConflicts.length }} / {{ conflicts.length }} 组待判断
        </span>
        <span v-else-if="activeReviewState !== 'all'" class="muted">
          显示 {{ visibleItems.length }} 条{{ activeReviewState === 'pending' ? '待确认' : '已确认' }}偏好
        </span>
        <span v-else class="muted">
          {{ visibleItems.length === items.length ? `${items.length} 条个人理解` : `显示 ${visibleItems.length} / ${items.length}` }}
        </span>
        <button class="toolbar-action" type="button" @click="load()">刷新</button>
      </div>
    </div>

    <section
      v-if="conflictsOnly"
      class="preference-conflict-workbench"
      aria-label="疑似冲突待判断组"
    >
      <header>
        <div>
          <p class="eyebrow">CONFLICT WORKBENCH</p>
          <h2>逐组成对比较，再决定如何生效</h2>
        </div>
        <p>系统只根据“同一偏好键、同一生效范围、内容不同”提出疑似冲突，不会自动覆盖任何记录。</p>
      </header>
      <div class="preference-conflict-list">
        <article
          v-for="(conflict, index) in visibleConflicts"
          :key="conflict.id"
          class="preference-conflict-card"
        >
          <div class="preference-conflict-card-heading">
            <div>
              <span>待判断组 {{ index + 1 }}</span>
              <h3>{{ conflict.preferenceKey }}</h3>
            </div>
            <div>
              <span>{{ conflictScopeLabel(conflict) }}</span>
              <strong>
                {{
                  conflict.aiRecord
                    ? '待 AI 使用时判断'
                    : conflict.recommendedAction === 'merge'
                      ? '建议合并'
                      : '需要人工判断'
                }}
              </strong>
            </div>
          </div>
          <div class="preference-conflict-pair">
            <section>
              <span>A · 较早记录</span>
              <strong>{{ conflict.left.title }}</strong>
              <p>{{ preferenceValue(conflict.left) }}</p>
              <small>{{ formatTime(latestItemValue(conflict.left)) }}</small>
            </section>
            <i aria-hidden="true">↔</i>
            <section>
              <span>B · 较新记录</span>
              <strong>{{ conflict.right.title }}</strong>
              <p>{{ preferenceValue(conflict.right) }}</p>
              <small>{{ formatTime(latestItemValue(conflict.right)) }}</small>
            </section>
          </div>
          <footer>
            <div>
              <span>判断原因</span>
              <p>{{ conflict.reason }}</p>
              <small v-if="conflict.difference.rightOnly.length">
                B 新增：{{ conflict.difference.rightOnly.join('、') }}
              </small>
            </div>
            <div class="preference-conflict-actions">
              <button
                class="secondary-action"
                type="button"
                :disabled="Boolean(conflict.aiRecord) || deferringConflictId === conflict.id"
                @click="deferConflictToAi(conflict)"
              >
                {{
                  conflict.aiRecord
                    ? '已交给 AI'
                    : deferringConflictId === conflict.id
                      ? '正在交给 AI…'
                      : '交给 AI，使用时处理'
                }}
              </button>
              <button class="primary-action" type="button" @click="activeConflict = conflict">
                现在人工处理
              </button>
            </div>
          </footer>
        </article>
      </div>
      <div v-if="loading || !visibleConflicts.length" class="empty-state">
        {{ loading ? '正在检查疑似冲突…' : conflicts.length ? '当前筛选范围没有疑似冲突' : '当前没有需要处理的疑似冲突' }}
      </div>
    </section>

    <div v-else class="personal-profile-layout">
      <section class="personal-profile-directory" aria-label="协作偏好内容">
        <div class="personal-profile-table-head" aria-hidden="true">
          <span>维度</span><span>内容</span><span>状态、范围与来源</span><span>更新时间</span>
        </div>
        <div class="personal-profile-list">
          <button
            v-for="item in visibleItems"
            :key="`${item.itemKind}:${item.id}`"
            class="personal-profile-row"
            :class="{
              selected: selectedItem?.id === item.id,
              'pending-review': knowledgeReviewState(item) === 'pending',
              'ai-resolved-conflict': aiResolvedIds.has(item.id),
            }"
            type="button"
            @click="selectedItem = item"
          >
            <span class="profile-aspect-mark" :class="item.profileAspect">{{ profileAspectLabel(item.profileAspect) }}</span>
            <span class="personal-profile-copy"><strong>{{ item.title }}</strong><small>{{ item.body }}</small></span>
            <span class="personal-profile-origin">
              <strong :class="{ 'has-conflict': conflictingIds.has(item.id) }">{{ statusLabel(item) }}</strong>
              <small>{{ quadrantLabel(item.originQuadrant) }} · {{ scopeLabel(item) }} · {{ item.evidence.length }} 个来源</small>
            </span>
            <time>{{ formatTime(latestItemValue(item)) }}</time>
          </button>
        </div>
        <div v-if="loading || !visibleItems.length" class="empty-state">
          {{ loading ? '正在读取协作偏好…' : items.length ? '当前维度和范围还没有内容' : '会话中出现稳定偏好后，会在这里形成可纠正的协作偏好。' }}
        </div>
      </section>
      <KnowledgeInspector
        class="personal-profile-inspector"
        :item="selectedItem"
        :graph="graph"
        editable
        @confirm="confirmingItem = $event"
        @edit="editingItem = $event"
        @open-replacement="openReplacement"
      />
    </div>
    <KnowledgeEditDialog
      :item="editingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :personal-project-id="null"
      :projects="store.state?.personalProjects ?? []"
      :replacement-items="items"
      @close="editingItem = null"
      @saved="load()"
    />
    <KnowledgeConfirmDialog
      :item="confirmingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :personal-project-id="null"
      @close="confirmingItem = null"
      @saved="load()"
    />
    <PreferenceConflictDialog
      :conflict="activeConflict"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :projects="store.state?.personalProjects ?? []"
      @close="activeConflict = null"
      @resolved="load()"
      @edit="editConflictItem"
    />
  </section>
</template>

<style scoped>
.preference-conflict-alert {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 13px;
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid #d6ddd8;
  border-radius: 11px;
  background: #f7f9f7;
  box-shadow: 0 7px 20px rgba(49, 66, 56, 0.05);
}

.preference-conflict-alert-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 50%;
  background: #52685b;
  color: #fff;
  font-size: 16px;
  font-weight: 800;
}

.preference-conflict-alert > div:nth-child(2) {
  display: grid;
  gap: 2px;
}

.preference-conflict-alert span {
  color: #65736b;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.preference-conflict-alert h2,
.preference-conflict-alert p {
  margin: 0;
}

.preference-conflict-alert h2 {
  color: #344239;
  font-size: 14px;
}

.preference-conflict-alert p {
  color: #6f7972;
  font-size: 10px;
  line-height: 1.5;
}

.preference-conflict-workbench {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 18px 0 4px;
}

.preference-conflict-workbench > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 0 2px 14px;
}

.preference-conflict-workbench h2,
.preference-conflict-workbench p {
  margin: 0;
}

.preference-conflict-workbench h2 {
  color: #2e3d35;
  font-size: 17px;
}

.preference-conflict-workbench > header > p {
  max-width: 520px;
  color: #778079;
  font-size: 10px;
  line-height: 1.55;
  text-align: right;
}

.preference-conflict-list {
  display: grid;
  gap: 12px;
}

.preference-conflict-card {
  display: grid;
  gap: 12px;
  padding: 15px;
  border: 1px solid #d9dfdb;
  border-radius: 11px;
  background: #fff;
  box-shadow: 0 7px 20px rgba(45, 61, 52, 0.04);
}

.preference-conflict-card-heading,
.preference-conflict-card footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.preference-conflict-card-heading > div {
  display: grid;
  gap: 3px;
}

.preference-conflict-card-heading > div:last-child {
  justify-items: end;
}

.preference-conflict-card-heading span,
.preference-conflict-card footer span {
  color: #7d8780;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}

.preference-conflict-card-heading h3 {
  margin: 0;
  color: #344239;
  font-size: 14px;
}

.preference-conflict-card-heading strong {
  color: #53685b;
  font-size: 10px;
}

.preference-conflict-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 26px minmax(0, 1fr);
  align-items: stretch;
  gap: 8px;
}

.preference-conflict-pair > section {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 12px;
  border: 1px solid #e0e5e1;
  border-radius: 8px;
  background: #fff;
}

.preference-conflict-pair > section:first-child {
  border-color: #c7ddec;
  background: #f5fafe;
}

.preference-conflict-pair > section:last-child {
  border-color: #d8ceeb;
  background: #faf8fd;
}

.preference-conflict-pair span,
.preference-conflict-pair small {
  color: #7d8780;
  font-size: 9px;
}

.preference-conflict-pair strong {
  color: #35423a;
  font-size: 11px;
}

.preference-conflict-pair p {
  color: #566159;
  font-size: 10px;
  line-height: 1.55;
}

.preference-conflict-pair > i {
  align-self: center;
  color: #9b9486;
  font-size: 14px;
  font-style: normal;
  text-align: center;
}

.preference-conflict-card footer {
  padding-top: 11px;
  border-top: 1px solid #e5e9e6;
}

.preference-conflict-card footer > div {
  display: grid;
  gap: 4px;
}

.preference-conflict-card footer p {
  color: #5d625d;
  font-size: 10px;
}

.preference-conflict-card footer small {
  color: #758079;
  font-size: 9px;
}

.preference-conflict-card footer button {
  flex: 0 0 auto;
}

.preference-conflict-card footer .preference-conflict-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.preference-conflict-card footer .preference-conflict-actions .secondary-action {
  color: #5e665f;
  background: #f5f7f5;
}

.personal-profile-row.ai-resolved-conflict {
  border-color: #b8d5c3;
  background: #f6fbf8;
}

.personal-profile-row.ai-resolved-conflict .personal-profile-origin strong {
  color: #39724f;
}

.personal-profile-inspector :deep(.inspector-classification.state-pending),
.personal-profile-inspector :deep(.inspector-classification.state-needs_review) {
  border-color: #d8dfda;
  background: #f5f7f5;
}

.personal-profile-inspector :deep(.inspector-classification.state-pending strong),
.personal-profile-inspector :deep(.inspector-classification.state-needs_review strong) {
  color: #53645a;
}

@media (max-width: 860px) {
  .preference-conflict-alert {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .preference-conflict-alert > button {
    grid-column: 1 / -1;
  }

  .preference-conflict-workbench > header,
  .preference-conflict-card-heading,
  .preference-conflict-card footer {
    align-items: stretch;
    flex-direction: column;
  }

  .preference-conflict-workbench > header > p {
    text-align: left;
  }

  .preference-conflict-card-heading > div:last-child {
    justify-items: start;
  }

  .preference-conflict-pair {
    grid-template-columns: 1fr;
  }

  .preference-conflict-card footer .preference-conflict-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
</style>
