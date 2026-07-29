<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { patchJson, postJson } from '@/api/client'
import { formatTime, latestItemValue } from '@/features/knowledge/model'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeItem, PersonalProject } from '@/types'
import {
  mergePreferenceValues,
  preferenceValue,
  type PreferenceConflict,
  type PreferenceConflictAction,
} from './preference-conflicts'

const props = defineProps<{
  conflict: PreferenceConflict | null
  personalSpaceId: string
  projects: PersonalProject[]
}>()

const emit = defineEmits<{
  close: []
  resolved: []
  edit: [item: KnowledgeItem]
}>()

const store = useConsoleStore()
const action = ref<PreferenceConflictAction | null>(null)
const mergeTarget = ref<'left' | 'right'>('right')
const splitItem = ref<'left' | 'right'>('right')
const splitProjectId = ref('')
const mergedValue = ref('')
const reason = ref('')
const generatedReason = ref('')
const busy = ref(false)
const localError = ref('')

const splitProjects = computed(() => {
  const conflict = props.conflict
  if (!conflict) return []
  const item = splitItem.value === 'left' ? conflict.left : conflict.right
  return props.projects.filter(
    ({ project_id: projectId }) =>
      item.preferenceScope !== 'project' || projectId !== item.preferenceProjectId,
  )
})
const canSplit = computed(() => splitProjects.value.length > 0)
const impactPreview = computed(() => {
  const conflict = props.conflict
  if (!conflict || !action.value) {
    return '先选择处理方式；确认前不会写入任何更改。'
  }
  if (action.value === 'merge') {
    const target = mergeTarget.value === 'left' ? conflict.left : conflict.right
    const historical = mergeTarget.value === 'left' ? conflict.right : conflict.left
    return `“${target.title}”将更新为合并后的规范内容并由你确认；“${historical.title}”转为历史记录，并链接到保留项。两条记录的修订与来源仍可追溯。`
  }
  if (action.value === 'keep_left' || action.value === 'keep_right') {
    const kept = action.value === 'keep_left' ? conflict.left : conflict.right
    const historical = action.value === 'keep_left' ? conflict.right : conflict.left
    return `“${kept.title}”继续生效；“${historical.title}”转为历史记录，并明确指向保留项。`
  }
  const item = splitItem.value === 'left' ? conflict.left : conflict.right
  const project = splitProjects.value.find(
    ({ project_id: projectId }) => projectId === splitProjectId.value,
  )
  return project
    ? `“${item.title}”将改为仅在“${project.profile.name}”生效；另一条保留原范围，两条内容不再争夺同一个生效位置。`
    : '请选择一个不同的项目范围，系统才会执行拆分。'
})

watch(
  () => props.conflict,
  (conflict) => {
    if (!conflict) return
    mergeTarget.value = 'right'
    splitItem.value = 'right'
    mergedValue.value = mergePreferenceValues(
      preferenceValue(conflict.right),
      preferenceValue(conflict.left),
    )
    action.value = conflict.recommendedAction
    splitProjectId.value = ''
    localError.value = ''
    setGeneratedReason(conflict.recommendedAction)
  },
  { immediate: true },
)

watch([splitItem, splitProjects], () => {
  if (
    splitProjectId.value
    && splitProjects.value.some(
      ({ project_id: projectId }) => projectId === splitProjectId.value,
    )
  ) return
  splitProjectId.value = splitProjects.value[0]?.project_id ?? ''
}, { immediate: true })

function chooseAction(nextAction: PreferenceConflictAction) {
  action.value = nextAction
  if (!reason.value.trim() || reason.value === generatedReason.value) {
    setGeneratedReason(nextAction)
  }
}

function setGeneratedReason(nextAction: PreferenceConflictAction | null) {
  const conflict = props.conflict
  const nextReason = conflict && nextAction
    ? defaultReason(nextAction, conflict)
    : ''
  generatedReason.value = nextReason
  reason.value = nextReason
}

async function resolveConflict() {
  const conflict = props.conflict
  if (!conflict || !action.value) return fail('请选择一种处理方式')
  if (!reason.value.trim()) return fail('请说明本次判断依据')
  if (action.value === 'merge' && !mergedValue.value.trim()) {
    return fail('合并后的规范内容不能为空')
  }
  if (action.value === 'split_scope' && !splitProjectId.value) {
    return fail('请选择拆分后的项目范围')
  }

  busy.value = true
  localError.value = ''
  try {
    if (action.value === 'merge') await mergeConflict(conflict)
    else if (action.value === 'split_scope') await splitConflictScope(conflict)
    else await keepOneConflictItem(conflict, action.value)
    if (conflict.aiRecord) {
      await postJson(
        `/api/preference-conflicts/${encodeURIComponent(conflict.aiRecord.id)}/complete`,
        {
          personalSpaceId: props.personalSpaceId,
          resolution: action.value,
          reason: reason.value.trim(),
        },
      )
    }
    store.notify('疑似冲突已处理，生效结果与历史记录均已更新。')
    emit('resolved')
    emit('close')
  } catch (error) {
    localError.value = error instanceof Error ? error.message : '冲突处理失败'
    store.reportError(error)
  } finally {
    busy.value = false
  }
}

async function mergeConflict(conflict: PreferenceConflict) {
  const target = mergeTarget.value === 'left' ? conflict.left : conflict.right
  const historical = mergeTarget.value === 'left' ? conflict.right : conflict.left
  const update: Record<string, unknown> = {
    personalSpaceId: props.personalSpaceId,
    personalProjectId: null,
    action: 'update',
    reason: reason.value.trim(),
  }
  if (target.itemKind === 'entity') {
    update.name = target.title
    update.summary = mergedValue.value.trim()
  } else {
    update.fact = mergedValue.value.trim()
  }
  if (target.classificationExplicit && target.originQuadrant !== 'unclassified') {
    update.originQuadrant = target.originQuadrant
    update.confirmationStatus = 'confirmed'
    update.confirmationBasis = {
      existenceReason: `由两条疑似冲突偏好合并：${conflict.reason}`,
      quadrantReason: target.confirmationBasis?.quadrant_reason
        || target.reasoningSummary
        || '沿用保留记录的发现时分类。',
      proposedBy: target.confirmationBasis?.proposed_by
        ? actorInput(target.confirmationBasis.proposed_by)
        : { kind: 'import', label: '历史记录' },
      confirmedBy: { kind: 'user', label: '用户' },
      confirmedAt: new Date().toISOString(),
    }
  }

  await patchJson(
    `/api/knowledge/${target.itemKind}/${encodeURIComponent(target.id)}`,
    update,
  )
  await patchJson(
    `/api/knowledge/${historical.itemKind}/${encodeURIComponent(historical.id)}`,
    {
      personalSpaceId: props.personalSpaceId,
      personalProjectId: null,
      action: 'invalidate',
      reason: reason.value.trim(),
      replacementItemId: target.id,
      replacementItemKind: target.itemKind,
    },
  )
}

async function keepOneConflictItem(
  conflict: PreferenceConflict,
  selectedAction: 'keep_left' | 'keep_right',
) {
  const kept = selectedAction === 'keep_left' ? conflict.left : conflict.right
  const historical = selectedAction === 'keep_left' ? conflict.right : conflict.left
  await patchJson(
    `/api/knowledge/${historical.itemKind}/${encodeURIComponent(historical.id)}`,
    {
      personalSpaceId: props.personalSpaceId,
      personalProjectId: null,
      action: 'invalidate',
      reason: reason.value.trim(),
      replacementItemId: kept.id,
      replacementItemKind: kept.itemKind,
    },
  )
}

async function splitConflictScope(conflict: PreferenceConflict) {
  const item = splitItem.value === 'left' ? conflict.left : conflict.right
  await postJson(
    `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}/preference-scope`,
    {
      personalSpaceId: props.personalSpaceId,
      scope: 'project',
      projectId: splitProjectId.value,
      reason: reason.value.trim(),
    },
  )
}

function actorInput(actor: { kind: string; label?: string | null }) {
  return { kind: actor.kind, label: actor.label ?? null }
}

function defaultReason(
  nextAction: PreferenceConflictAction,
  conflict: PreferenceConflict,
) {
  if (nextAction === 'merge') {
    return '两条偏好描述同一规则且内容互补，合并为一条规范版本。'
  }
  if (nextAction === 'keep_left') {
    return `较早记录“${conflict.left.title}”仍是当前准确口径，另一条转为历史。`
  }
  if (nextAction === 'keep_right') {
    return `较新记录“${conflict.right.title}”是当前准确口径，另一条转为历史。`
  }
  return '两条偏好适用于不同项目，拆分生效范围并同时保留。'
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <dialog v-if="conflict" open class="project-dialog conflict-resolution-dialog vue-dialog">
    <div class="project-dialog-shell conflict-resolution-shell">
      <header class="project-dialog-header">
        <div>
          <p class="eyebrow">CONFLICT RESOLUTION</p>
          <h3>比较并处理疑似冲突</h3>
          <p>{{ conflict.reason }} 系统只提供证据和影响预览，最终决定由你确认。</p>
        </div>
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          关闭
        </button>
      </header>

      <section class="conflict-pair-context" aria-label="冲突判断依据">
        <span>偏好键 <strong>{{ conflict.preferenceKey }}</strong></span>
        <span>生效范围 <strong>{{ conflict.scopeLabel }}</strong></span>
        <span>
          建议
          <strong>
            {{ conflict.recommendedAction === 'merge' ? '内容互补，优先合并' : '差异较大，先人工判断' }}
          </strong>
        </span>
      </section>

      <section class="conflict-comparison" aria-label="冲突双方">
        <article class="conflict-side conflict-side-left">
          <div class="conflict-side-heading">
            <span>A · 较早记录</span>
            <time>{{ formatTime(latestItemValue(conflict.left)) }}</time>
          </div>
          <h4>{{ conflict.left.title }}</h4>
          <p>{{ preferenceValue(conflict.left) }}</p>
          <small>{{ conflict.left.evidence.length }} 个来源 · {{ conflict.left.id }}</small>
          <button class="text-action" type="button" @click="emit('edit', conflict.left)">
            单独纠正 A
          </button>
        </article>
        <article class="conflict-side conflict-side-right">
          <div class="conflict-side-heading">
            <span>B · 较新记录</span>
            <time>{{ formatTime(latestItemValue(conflict.right)) }}</time>
          </div>
          <h4>{{ conflict.right.title }}</h4>
          <p>{{ preferenceValue(conflict.right) }}</p>
          <small>{{ conflict.right.evidence.length }} 个来源 · {{ conflict.right.id }}</small>
          <button class="text-action" type="button" @click="emit('edit', conflict.right)">
            单独纠正 B
          </button>
        </article>
      </section>

      <section class="conflict-difference" aria-label="差异摘要">
        <div>
          <span>双方共有</span>
          <p v-if="conflict.difference.shared.length">
            <b v-for="value in conflict.difference.shared" :key="value">{{ value }}</b>
          </p>
          <p v-else class="muted">没有检测到可以直接对齐的共同片段</p>
        </div>
        <div>
          <span>仅 A 有</span>
          <p v-if="conflict.difference.leftOnly.length">
            <b v-for="value in conflict.difference.leftOnly" :key="value">{{ value }}</b>
          </p>
          <p v-else class="muted">没有独有片段</p>
        </div>
        <div>
          <span>仅 B 有</span>
          <p v-if="conflict.difference.rightOnly.length">
            <b v-for="value in conflict.difference.rightOnly" :key="value">{{ value }}</b>
          </p>
          <p v-else class="muted">没有独有片段</p>
        </div>
      </section>

      <section class="conflict-resolution-options" aria-label="处理方式">
        <button
          type="button"
          :aria-pressed="action === 'merge'"
          @click="chooseAction('merge')"
        >
          <strong>合并为规范版本</strong>
          <span>保留双方独有信息；一条更新，一条转为历史。</span>
          <em v-if="conflict.recommendedAction === 'merge'">推荐</em>
        </button>
        <button
          type="button"
          :aria-pressed="action === 'keep_left'"
          @click="chooseAction('keep_left')"
        >
          <strong>保留 A</strong>
          <span>B 转为历史，并链接到 A。</span>
        </button>
        <button
          type="button"
          :aria-pressed="action === 'keep_right'"
          @click="chooseAction('keep_right')"
        >
          <strong>保留 B</strong>
          <span>A 转为历史，并链接到 B。</span>
        </button>
        <button
          type="button"
          :disabled="!canSplit"
          :aria-pressed="action === 'split_scope'"
          @click="chooseAction('split_scope')"
        >
          <strong>拆分生效范围</strong>
          <span>{{ canSplit ? '两条都保留，但不再作用于同一范围。' : '没有其他个人项目可选。' }}</span>
        </button>
      </section>

      <section v-if="action === 'merge'" class="conflict-resolution-detail">
        <div class="conflict-inline-options" role="group" aria-label="合并后保留哪条记录">
          <span>规范版本沿用</span>
          <button type="button" :aria-pressed="mergeTarget === 'left'" @click="mergeTarget = 'left'">
            A 的记录身份
          </button>
          <button type="button" :aria-pressed="mergeTarget === 'right'" @click="mergeTarget = 'right'">
            B 的记录身份
          </button>
        </div>
        <label>
          合并后的规范内容
          <textarea v-model="mergedValue" rows="4" maxlength="4096" />
        </label>
      </section>

      <section v-if="action === 'split_scope'" class="conflict-resolution-detail">
        <div class="conflict-inline-options" role="group" aria-label="调整哪条记录">
          <span>调整记录</span>
          <button type="button" :aria-pressed="splitItem === 'left'" @click="splitItem = 'left'">
            A
          </button>
          <button type="button" :aria-pressed="splitItem === 'right'" @click="splitItem = 'right'">
            B
          </button>
        </div>
        <label>
          改为仅在以下项目生效
          <select v-model="splitProjectId">
            <option value="" disabled>请选择个人项目</option>
            <option
              v-for="project in splitProjects"
              :key="project.project_id"
              :value="project.project_id"
            >
              {{ project.profile.name }}
            </option>
          </select>
        </label>
      </section>

      <section class="conflict-impact-preview">
        <span>确认后会发生什么</span>
        <p>{{ impactPreview }}</p>
      </section>

      <label class="conflict-resolution-reason">
        本次判断依据
        <textarea v-model="reason" rows="2" maxlength="2000" />
      </label>
      <p v-if="localError" class="dialog-error">{{ localError }}</p>

      <footer class="project-dialog-actions conflict-resolution-actions">
        <span>暂不处理不会更改数据，这组记录会继续显示为疑似冲突。</span>
        <div>
          <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
            暂不处理
          </button>
          <button
            class="primary-action"
            type="button"
            :disabled="busy || !action"
            @click="resolveConflict"
          >
            {{ busy ? '正在处理…' : '确认并执行' }}
          </button>
        </div>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.conflict-resolution-dialog.vue-dialog {
  width: min(1180px, calc(100vw - 48px));
}

.conflict-resolution-shell {
  overflow: auto;
}

.conflict-pair-context {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 0;
}

.conflict-pair-context span {
  padding: 6px 9px;
  border: 1px solid #e1e5e2;
  border-radius: 999px;
  color: #747d77;
  font-size: 10px;
}

.conflict-pair-context strong {
  margin-left: 4px;
  color: #3c4941;
}

.conflict-comparison {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.conflict-side {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 16px;
  border: 1px solid #dfe5e1;
  border-radius: 10px;
  background: #f9fbfa;
}

.conflict-side-left {
  border-color: #b8d8ef;
  background: #f1f8fd;
}

.conflict-side-right {
  border-color: #d2c6ef;
  background: #f7f4fd;
}

.conflict-side-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #69736c;
  font-size: 10px;
}

.conflict-side h4,
.conflict-side p {
  margin: 0;
}

.conflict-side h4 {
  color: #2f3d35;
  font-size: 14px;
}

.conflict-side p {
  min-height: 48px;
  color: #45524a;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.conflict-side small {
  overflow: hidden;
  color: #7c857f;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text-action {
  justify-self: start;
  padding: 0;
  border: 0;
  color: #52705f;
  background: transparent;
  font-size: 10px;
}

.conflict-difference {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #e5e7e5;
  border-radius: 9px;
  background: #fbfcfb;
}

.conflict-difference > div {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 7px;
}

.conflict-difference span {
  color: #7a837d;
  font-size: 9px;
  font-weight: 700;
}

.conflict-difference p {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
}

.conflict-difference b {
  padding: 4px 7px;
  border-radius: 5px;
  color: #46534b;
  background: #e9efeb;
  font-size: 10px;
  font-weight: 600;
}

.conflict-difference .muted {
  display: block;
  color: #929993;
  font-size: 10px;
}

.conflict-resolution-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.conflict-resolution-options > button {
  position: relative;
  min-height: 86px;
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 12px;
  border: 1px solid #dfe4e0;
  border-radius: 9px;
  color: #3d4942;
  background: #fff;
  text-align: left;
}

.conflict-resolution-options > button[aria-pressed='true'] {
  border-color: #7ba08a;
  background: #f1f7f3;
  box-shadow: inset 0 0 0 1px #7ba08a;
}

.conflict-resolution-options strong {
  font-size: 11px;
}

.conflict-resolution-options span {
  color: #7a837d;
  font-size: 9px;
  line-height: 1.45;
}

.conflict-resolution-options em {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 2px 5px;
  border-radius: 999px;
  color: #376047;
  background: #dcecdf;
  font-size: 8px;
  font-style: normal;
}

.conflict-resolution-detail,
.conflict-impact-preview {
  display: grid;
  gap: 10px;
  margin-top: 12px;
  padding: 13px;
  border: 1px solid #dfe5e1;
  border-radius: 9px;
  background: #fafcfb;
}

.conflict-resolution-detail label,
.conflict-resolution-reason {
  display: grid;
  gap: 6px;
  color: #5f6962;
  font-size: 10px;
  font-weight: 600;
}

.conflict-resolution-detail textarea,
.conflict-resolution-reason textarea,
.conflict-resolution-detail select {
  width: 100%;
}

.conflict-inline-options {
  display: flex;
  align-items: center;
  gap: 6px;
}

.conflict-inline-options span {
  margin-right: 4px;
  color: #667169;
  font-size: 10px;
}

.conflict-inline-options button {
  padding: 5px 8px;
  border: 1px solid #d9dfdb;
  border-radius: 6px;
  color: #58645c;
  background: #fff;
  font-size: 10px;
}

.conflict-inline-options button[aria-pressed='true'] {
  border-color: #789986;
  color: #315141;
  background: #eaf2ed;
}

.conflict-impact-preview {
  border-color: #f0d99d;
  background: #fffaf0;
}

.conflict-impact-preview span {
  color: #826b37;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}

.conflict-impact-preview p {
  margin: 0;
  color: #554d3c;
  font-size: 11px;
  line-height: 1.55;
}

.conflict-resolution-reason {
  margin-top: 12px;
}

.conflict-resolution-actions > div {
  display: flex;
  gap: 8px;
}

@media (max-width: 900px) {
  .conflict-comparison,
  .conflict-difference {
    grid-template-columns: 1fr;
  }

  .conflict-resolution-options {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
