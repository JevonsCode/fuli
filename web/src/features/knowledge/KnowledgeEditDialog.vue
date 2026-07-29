<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import { patchJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { quadrantLabel } from './model'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeEdge, KnowledgeItem, KnowledgeNode, PersonalProject } from '@/types'

const props = withDefaults(defineProps<{
  item: KnowledgeItem | null
  personalSpaceId: string
  personalProjectId: string | null
  projects: PersonalProject[]
  replacementItems?: KnowledgeItem[]
}>(), {
  replacementItems: () => [],
})

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useConsoleStore()
const busy = ref(false)
const localError = ref('')
const assignmentReason = ref('')
const targetProjectId = ref('')
const preferenceScope = ref('global')
const preferenceProjectId = ref('')
const preferenceReason = ref('')
const inheritanceProjectId = ref('')
const replacementItemKey = ref('')
const form = reactive({
  name: '',
  summary: '',
  fact: '',
  currentQuadrant: '',
  confirmationStatus: 'pending',
  existenceReason: '',
  quadrantReason: '',
  proposedByKind: 'agent',
  proposedByLabel: '',
  confirmedByKind: 'user',
  confirmedByLabel: '',
  profileAspect: 'none',
  inheritanceMode: 'local_only',
  reason: '',
})

const relationship = computed(() => props.item?.itemKind === 'relationship')
const invalid = computed(() => Boolean(props.item?.invalidAt))
const profilePreference = computed(() => Boolean(props.item?.raw.profile_aspect))
const projectOptions = computed(() =>
  props.projects.map((project) => ({
    value: project.project_id,
    label: project.profile.name,
    meta: `#${compactIdentity(project.project_id, 26)}`,
    search: identitySearchText(project.project_id),
  })),
)
const quadrantOptions = [
  { value: 'known_known', label: '已知的已知 · 被明确表达的知识或结论' },
  { value: 'known_unknown', label: '已知的未知 · 被明确提出的未解问题' },
  { value: 'unknown_known', label: '未知的已知 · 从行为或反馈提炼的隐性知识' },
  { value: 'unknown_unknown', label: '未知的未知 · 探索中发现的潜在盲点' },
]
const confirmationStatusOptions = [
  { value: 'pending', label: '待确认 · 尚未完成内容与象限审核' },
  { value: 'confirmed', label: '已确认 · 内容与象限归类均已确认' },
]
const inheritanceModeOptions = [
  { value: 'local_only', label: '仅当前项目 · 不自动借给其他项目' },
  { value: 'descendants', label: '子项目可继承 · 仅沿明确知识关系' },
  { value: 'selected_projects', label: '仅指定项目可继承' },
]
const proposerOptions = [
  { value: 'user', label: '用户' },
  { value: 'agent', label: 'Agent' },
  { value: 'authoritative_source', label: '权威来源' },
  { value: 'import', label: '导入记录' },
]
const confirmerOptions = [
  { value: 'user', label: '用户' },
  { value: 'authoritative_source', label: '权威来源' },
]
const profileAspectOptions = [
  { value: 'none', label: '不属于协作偏好' },
  { value: 'taste', label: '品味' },
  { value: 'personality', label: '个性' },
  { value: 'judgment_preference', label: '判断偏好' },
]
const preferenceScopeOptions = computed(() => [
  { value: 'global', label: '个人全局' },
  {
    value: 'project',
    label: '指定个人项目',
    disabled: props.projects.length === 0,
  },
])
const replacementOptions = computed(() => [
  { value: '', label: '没有明确的替代内容' },
  ...props.replacementItems
    .filter((candidate) =>
      !candidate.invalidAt
      && (
        candidate.itemKind !== props.item?.itemKind
        || candidate.id !== props.item?.id
      ),
    )
    .map((candidate) => ({
      value: replacementKey(candidate.itemKind, candidate.id),
      label: candidate.title,
      meta: candidate.type,
      search: `${candidate.body} ${candidate.id}`,
    })),
])
const selectedReplacement = computed(() => {
  if (!replacementItemKey.value) return null
  try {
    const [itemKind, id] = JSON.parse(replacementItemKey.value)
    if (
      (itemKind !== 'entity' && itemKind !== 'relationship')
      || typeof id !== 'string'
    ) return null
    return { itemKind, id } as const
  } catch {
    return null
  }
})
const currentProjectId = computed(() => {
  const assignment = props.item?.assignments.at(0) as { project_id?: string } | undefined
  return assignment?.project_id
    ?? props.item?.evidence.find(({ personal_project_id }) => personal_project_id)
      ?.personal_project_id
    ?? props.personalProjectId
    ?? null
})

watch(
  () => props.item,
  (item) => {
    if (!item) return
    const raw = item.raw
    form.name = item.itemKind === 'entity' ? (raw as KnowledgeNode).name : ''
    form.summary = item.itemKind === 'entity' ? ((raw as KnowledgeNode).summary ?? '') : ''
    form.fact = item.itemKind === 'relationship' ? ((raw as KnowledgeEdge).fact ?? '') : ''
    const basis = item.confirmationBasis
    const evidence = item.evidence.at(0)
    form.currentQuadrant = item.classificationExplicit
      ? raw.current_quadrant ?? raw.origin_quadrant ?? 'known_known'
      : ''
    form.confirmationStatus = item.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending'
    form.existenceReason = basis?.existence_reason
      ?? evidence?.source_description
      ?? evidence?.summary
      ?? ''
    form.quadrantReason = basis?.quadrant_reason ?? raw.reasoning_summary ?? ''
    form.proposedByKind = basis?.proposed_by.kind ?? 'agent'
    form.proposedByLabel = basis?.proposed_by.label ?? ''
    form.confirmedByKind = basis?.confirmed_by?.kind ?? 'user'
    form.confirmedByLabel = basis?.confirmed_by?.label ?? ''
    form.profileAspect = raw.profile_aspect ?? 'none'
    form.inheritanceMode = raw.profile_aspect
      ? 'local_only'
      : raw.inheritance_mode ?? 'local_only'
    inheritanceProjectId.value = raw.inherited_project_ids?.at(0)
      ?? props.projects[0]?.project_id
      ?? ''
    form.reason = ''
    assignmentReason.value = ''
    targetProjectId.value = currentProjectId.value ?? props.projects[0]?.project_id ?? ''
    preferenceScope.value = raw.preference_scope ?? 'global'
    preferenceProjectId.value = raw.preference_project_id ?? props.projects[0]?.project_id ?? ''
    preferenceReason.value = ''
    replacementItemKey.value = item.replacedByItemId && item.replacedByItemKind
      ? replacementKey(item.replacedByItemKind, item.replacedByItemId)
      : ''
    localError.value = ''
  },
  { immediate: true },
)

async function saveCorrection() {
  const item = props.item
  if (!item) return
  if (!form.reason.trim()) return fail('请说明纠正原因')
  if (!relationship.value && !form.name.trim()) return fail('名称不能为空')
  if (relationship.value && !form.fact.trim()) return fail('关系事实不能为空')
  if (!form.currentQuadrant || !form.confirmationStatus) {
    return fail('请先明确当前分类与确认状态')
  }
  if (!form.existenceReason.trim()) return fail('请说明为什么会有这条知识')
  if (!form.quadrantReason.trim()) return fail('请说明为什么被分到这个象限')
  if (!form.proposedByKind) return fail('请选择提出者')
  if (form.confirmationStatus === 'confirmed' && !form.confirmedByKind) {
    return fail('已确认状态必须记录确认者')
  }
  if (
    form.inheritanceMode === 'selected_projects'
    && !inheritanceProjectId.value
  ) return fail('请选择可以继承这条知识的项目')

  const body: Record<string, unknown> = {
    ...baseRevision('update'),
    confirmationStatus: form.confirmationStatus,
    confirmationBasis: {
      existenceReason: form.existenceReason.trim(),
      quadrantReason: form.quadrantReason.trim(),
      proposedBy: {
        kind: form.proposedByKind,
        label: form.proposedByLabel.trim() || null,
      },
      confirmedBy: form.confirmationStatus === 'confirmed'
        ? {
            kind: form.confirmedByKind,
            label: form.confirmedByLabel.trim() || null,
          }
        : null,
      confirmedAt: form.confirmationStatus === 'confirmed'
        ? new Date().toISOString()
        : null,
    },
    profileAspect: form.profileAspect,
    inheritanceMode: form.profileAspect === 'none'
      ? form.inheritanceMode
      : 'local_only',
    inheritedProjectIds: (
      form.profileAspect === 'none'
      && form.inheritanceMode === 'selected_projects'
    ) ? [inheritanceProjectId.value] : [],
    reasoningSummary: form.quadrantReason.trim(),
  }
  if (props.item.classificationExplicit) {
    body.currentQuadrant = form.currentQuadrant
  } else {
    body.originQuadrant = form.currentQuadrant
  }
  if (relationship.value) body.fact = form.fact.trim()
  else {
    body.name = form.name.trim()
    body.summary = form.summary.trim()
  }
  await execute(async () => {
    await patchJson(`/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`, body)
    store.notify('知识已纠正，原始证据仍然保留。')
  })
}

async function changeStatus(action: 'invalidate' | 'restore') {
  const item = props.item
  if (!item) return
  if (!form.reason.trim()) {
    return fail(action === 'invalidate' ? '请说明为什么这条知识已经失效' : '请说明为什么恢复有效')
  }
  await execute(async () => {
    const body: Record<string, unknown> = baseRevision(action)
    if (action === 'invalidate' && selectedReplacement.value) {
      body.replacementItemId = selectedReplacement.value.id
      body.replacementItemKind = selectedReplacement.value.itemKind
    }
    await patchJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`,
      body,
    )
    store.notify(
      action === 'invalidate'
        ? selectedReplacement.value
          ? '知识已标记为失效，并已关联替代内容。'
          : '知识已标记为失效，历史记录已保留。'
        : '知识已恢复为有效。',
    )
  })
}

async function saveReplacement() {
  const item = props.item
  const replacement = selectedReplacement.value
  if (!item || !invalid.value) return
  if (!replacement) return fail('请选择明确的替代内容')
  if (!form.reason.trim()) return fail('请说明补充替代关联的依据')
  await execute(async () => {
    await patchJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`,
      {
        ...baseRevision('link_replacement'),
        replacementItemId: replacement.id,
        replacementItemKind: replacement.itemKind,
      },
    )
    store.notify('替代关联已保存，现在可以从历史记录直接跳转。')
  })
}

async function saveAssignment() {
  const item = props.item
  if (!item) return
  if (!targetProjectId.value) return fail('请选择目标个人项目')
  if (!assignmentReason.value.trim()) return fail('请说明调整原因')
  if (targetProjectId.value === currentProjectId.value) return fail('这条知识已经属于该项目')
  await execute(async () => {
    await postJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}/assignment`,
      {
        personalSpaceId: props.personalSpaceId,
        targetProjectId: targetProjectId.value,
        reason: assignmentReason.value.trim(),
      },
    )
    store.notify('项目归属已调整，来源会话和历史证据没有改变。')
  })
}

async function savePreferenceScope() {
  const item = props.item
  if (!item) return
  const projectId = preferenceScope.value === 'project' ? preferenceProjectId.value : null
  if (preferenceScope.value === 'project' && !projectId) return fail('请选择生效的个人项目')
  if (!preferenceReason.value.trim()) return fail('请说明为什么调整生效范围')
  await execute(async () => {
    await postJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}/preference-scope`,
      {
        personalSpaceId: props.personalSpaceId,
        scope: preferenceScope.value,
        projectId,
        reason: preferenceReason.value.trim(),
      },
    )
    store.notify(
      preferenceScope.value === 'global'
        ? '这条协作偏好现在对所有个人项目生效。'
        : '这条协作偏好现在只对所选个人项目生效。',
    )
  })
}

function baseRevision(action: string) {
  return {
    personalSpaceId: props.personalSpaceId,
    personalProjectId: props.personalProjectId,
    action,
    reason: form.reason.trim(),
  }
}

function replacementKey(itemKind: KnowledgeItem['itemKind'], itemId: string) {
  return JSON.stringify([itemKind, itemId])
}

async function execute(operation: () => Promise<void>) {
  busy.value = true
  localError.value = ''
  try {
    await operation()
    emit('close')
    emit('saved')
  } catch (error) {
    localError.value = error instanceof Error ? error.message : '保存失败'
    store.reportError(error)
  } finally {
    busy.value = false
  }
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <dialog v-if="item" open class="project-dialog knowledge-edit-dialog vue-dialog">
    <div class="project-dialog-shell">
      <header class="project-dialog-header">
        <div>
          <p class="eyebrow">PERSONAL KNOWLEDGE</p>
          <h3>{{ invalid ? '查看和恢复知识' : '纠正知识' }}</h3>
          <p>修改会新增修订历史；发现时象限保持不变，当前分类可纠正，确认状态记录审核结果。</p>
        </div>
        <button class="secondary-action" type="button" @click="emit('close')">关闭</button>
      </header>

      <div class="knowledge-edit-columns">
        <section>
          <h4>当前内容</h4>
          <form class="knowledge-editor-form" @submit.prevent="saveCorrection">
            <label v-if="!relationship">名称<input v-model="form.name" maxlength="512" /></label>
            <label v-if="!relationship">说明<textarea v-model="form.summary" maxlength="4096" rows="5" /></label>
            <label v-else>关系事实<textarea v-model="form.fact" maxlength="8192" rows="5" /></label>
            <div class="knowledge-taxonomy-fields">
              <label>当前分类
                <SearchableSelect
                  v-model="form.currentQuadrant"
                  :options="quadrantOptions"
                  label="当前分类"
                />
              </label>
              <label>确认状态
                <SearchableSelect
                  v-model="form.confirmationStatus"
                  :options="confirmationStatusOptions"
                  label="确认状态"
                />
              </label>
              <label>协作偏好维度
                <SearchableSelect
                  v-model="form.profileAspect"
                  :options="profileAspectOptions"
                  label="协作偏好维度"
                />
              </label>
            </div>
            <p class="knowledge-classification-warning">
              发现时象限：{{ quadrantLabel(item.originQuadrant) }}。这是捕获来源标签，后续编辑不会覆盖。
            </p>
            <p v-if="!item.classificationExplicit" class="knowledge-classification-warning">
              这条旧内容没有显式象限。保存前请人工选择，系统不会再自动补成“已知的已知”。
            </p>
            <fieldset class="knowledge-confirmation-fields">
              <legend>确认依据</legend>
              <label>为什么会有这条知识
                <textarea v-model="form.existenceReason" maxlength="4096" rows="3" required />
              </label>
              <label>为什么被分到这个象限
                <textarea v-model="form.quadrantReason" maxlength="4096" rows="3" required />
              </label>
              <div class="knowledge-taxonomy-fields">
                <label>提出者
                  <SearchableSelect
                    v-model="form.proposedByKind"
                    :options="proposerOptions"
                    label="提出者"
                  />
                </label>
                <label>提出者说明
                  <input v-model="form.proposedByLabel" maxlength="160" placeholder="可选，例如 Codex" />
                </label>
                <template v-if="form.confirmationStatus === 'confirmed'">
                  <label>确认者
                    <SearchableSelect
                      v-model="form.confirmedByKind"
                      :options="confirmerOptions"
                      label="确认者"
                    />
                  </label>
                  <label>确认者说明
                    <input v-model="form.confirmedByLabel" maxlength="160" placeholder="可选，例如当前用户" />
                  </label>
                </template>
              </div>
              <p>
                “Agent 已确认”只能由实际使用证据策略产生；人工在这里可保留待确认，或记录用户/权威来源确认。
              </p>
            </fieldset>
            <fieldset v-if="!profilePreference" class="knowledge-replacement-fields">
              <legend>跨项目知识继承</legend>
              <label>继承范围
                <SearchableSelect
                  v-model="form.inheritanceMode"
                  :options="inheritanceModeOptions"
                  label="知识继承范围"
                />
              </label>
              <label v-if="form.inheritanceMode === 'selected_projects'">可继承项目
                <SearchableSelect
                  v-model="inheritanceProjectId"
                  :options="projectOptions"
                  label="可继承项目"
                  searchable
                />
              </label>
              <p>
                只有沿 PART_OF 或 USES_KNOWLEDGE_FROM 可达时才会继承；RELATED_TO 不扩展检索范围。
              </p>
            </fieldset>
            <fieldset class="knowledge-replacement-fields">
              <legend>{{ invalid ? '替代内容' : '失效时的替代内容（可选）' }}</legend>
              <label>{{ invalid ? '这条历史记录被哪条内容取代' : '选择当前有效的内容' }}
                <SearchableSelect
                  v-model="replacementItemKey"
                  :options="replacementOptions"
                  label="替代内容"
                  searchable
                />
              </label>
              <p>
                只有明确选择后才会建立可跳转的替代关联；系统不会根据失效原因自动猜测。
              </p>
            </fieldset>
            <label>纠正原因<textarea v-model="form.reason" maxlength="2000" rows="3" required /></label>
            <p v-if="localError" class="publish-dialog-error" role="alert">{{ localError }}</p>
            <div class="knowledge-editor-actions">
              <button v-if="!invalid" class="secondary-action" type="button" :disabled="busy" @click="changeStatus('invalidate')">标记为失效</button>
              <template v-else>
                <button class="secondary-action" type="button" :disabled="busy" @click="changeStatus('restore')">恢复为有效</button>
                <button class="secondary-action" type="button" :disabled="busy" @click="saveReplacement">保存替代关联</button>
              </template>
              <button class="primary-action" type="submit" :disabled="busy">
                {{ busy ? '正在保存…' : form.confirmationStatus === 'confirmed' ? '保存并确认' : '保存为待确认' }}
              </button>
            </div>
          </form>
        </section>

        <section v-if="!profilePreference">
          <h4>项目归属</h4>
          <p>只调整这条知识的项目归属，来源会话和历史证据保持不变。</p>
          <form class="knowledge-editor-form" @submit.prevent="saveAssignment">
            <label>目标个人项目
              <SearchableSelect
                v-model="targetProjectId"
                :options="projectOptions"
                label="目标个人项目"
                searchable
                required
              />
            </label>
            <label>调整原因<textarea v-model="assignmentReason" maxlength="2000" rows="3" required /></label>
            <button class="primary-action" type="submit" :disabled="busy || projects.length === 0">调整归属</button>
          </form>
        </section>

        <section v-else>
          <h4>偏好生效范围</h4>
          <p>个人全局默认跨项目生效；项目范围只对明确选择的项目生效。</p>
          <form class="knowledge-editor-form" @submit.prevent="savePreferenceScope">
            <label>生效范围
              <SearchableSelect
                v-model="preferenceScope"
                :options="preferenceScopeOptions"
                label="偏好生效范围"
              />
            </label>
            <label v-if="preferenceScope === 'project'">个人项目
              <SearchableSelect
                v-model="preferenceProjectId"
                :options="projectOptions"
                label="偏好个人项目"
                searchable
              />
            </label>
            <label>调整原因<textarea v-model="preferenceReason" maxlength="2000" rows="3" required /></label>
            <button class="primary-action" type="submit" :disabled="busy">保存生效范围</button>
          </form>
        </section>
      </div>
    </div>
  </dialog>
</template>
