<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeItem, KnowledgeNode, PersonalProject } from '@/types'

type ProjectMode = 'create' | 'existing'
type ConflictResolution = 'defer' | 'keep_target' | 'use_source' | 'coexist'
type RelationType =
  | 'RELATED_TO'
  | 'PART_OF'
  | 'USES_KNOWLEDGE_FROM'
  | 'DEPENDS_ON'
  | 'PROVIDES_TO'
  | 'SHARES_CAPABILITY_WITH'
  | 'SUCCESSOR_OF'

interface ProjectActionPreview {
  item_name: string
  item_summary?: string
  match: {
    kind: 'none' | 'already_linked' | 'exact_duplicate' | 'conflict'
    reason: string
    item_name?: string
    item_summary?: string
  }
}

interface ProjectActionResult {
  status:
    | 'created'
    | 'linked'
    | 'already_linked'
    | 'duplicate_reused'
    | 'conflict_pending'
    | 'conflict_resolved'
    | string
}

const props = defineProps<{
  item: KnowledgeItem | null
  personalSpaceId: string
  personalProjectId: string | null
  projects: PersonalProject[]
}>()

const emit = defineEmits<{
  close: []
  saved: [result: ProjectActionResult, targetName: string]
}>()

const store = useConsoleStore()
const mode = ref<ProjectMode>('create')
const targetProjectId = ref('')
const newProjectName = ref('')
const newProjectId = ref('')
const newProjectPurpose = ref('')
const keepSourceRelation = ref(true)
const relationType = ref<RelationType>('RELATED_TO')
const conflictResolution = ref<ConflictResolution>('defer')
const reason = ref('')
const preview = ref<ProjectActionPreview | null>(null)
const previewLoading = ref(false)
const busy = ref(false)
const localError = ref('')
const idTouched = ref(false)
let previewSequence = 0

const rawNode = computed(() =>
  props.item?.itemKind === 'entity' ? (props.item.raw as KnowledgeNode) : null,
)
const sourceProjectId = computed(() => {
  const assignment = props.item?.assignments.at(0) as { project_id?: string } | undefined
  return assignment?.project_id
    ?? props.item?.evidence.find(({ personal_project_id }) => personal_project_id)
      ?.personal_project_id
    ?? props.personalProjectId
    ?? null
})
const availableProjects = computed(() =>
  props.projects.filter(({ project_id }) => project_id !== sourceProjectId.value),
)
const availableProjectOptions = computed(() =>
  availableProjects.value.map((project) => ({
    value: project.project_id,
    label: project.profile.name,
    meta: `#${compactIdentity(project.project_id, 26)}`,
    search: identitySearchText(project.project_id),
  })),
)
const selectedProject = computed(() =>
  availableProjects.value.find(({ project_id }) => project_id === targetProjectId.value) ?? null,
)
const previewState = computed(() => {
  if (mode.value === 'create') {
    return {
      label: '创建预览',
      title: '将创建一个新的个人项目',
      copy: sourceProjectId.value
        ? '当前节点继续由来源项目主要维护，新项目会引用它。'
        : '当前节点会成为新项目的主要归属知识。',
    }
  }
  if (previewLoading.value) {
    return {
      label: '正在检查',
      title: '正在检查重复与冲突…',
      copy: '只比较目标项目和当前节点。',
    }
  }
  if (!preview.value) {
    return {
      label: '等待检查',
      title: '请选择目标项目',
      copy: '选择后会先检查重复与冲突。',
    }
  }
  const labels = {
    none: ['可以加入', '未检测到重复或已确认的同名冲突'],
    already_linked: ['已经加入', '目标项目已经在使用这条知识'],
    exact_duplicate: ['发现重复', '将复用目标项目已有内容，不再创建副本'],
    conflict: ['发现冲突', '两条已确认知识同名，但内容不同'],
  } as const
  const [label, title] = labels[preview.value.match.kind] ?? labels.none
  return { label, title, copy: preview.value.match.reason }
})
const relationLabels = computed<Record<RelationType, string>>(() => {
  const subject = mode.value === 'existing' ? '来源项目' : '新项目'
  const object = mode.value === 'existing' ? '目标项目' : '来源项目'
  return {
    RELATED_TO: `与${object}相关`,
    PART_OF: `${subject}属于${object}`,
    USES_KNOWLEDGE_FROM: `${subject}从${object}继承共享知识`,
    DEPENDS_ON: `${subject}依赖${object}`,
    PROVIDES_TO: `${subject}向${object}提供能力`,
    SHARES_CAPABILITY_WITH: `与${object}共享能力`,
    SUCCESSOR_OF: `${subject}是${object}的后继`,
  }
})
const relationOptions = computed(() =>
  (Object.entries(relationLabels.value) as Array<[RelationType, string]>)
    .map(([value, label]) => ({ value, label })),
)
const submitLabel = computed(() => {
  if (busy.value) return '正在处理…'
  if (mode.value === 'create') return '创建项目'
  return preview.value?.match.kind === 'exact_duplicate' ? '复用现有内容' : '加入项目'
})
const submitDisabled = computed(() =>
  busy.value
  || (mode.value === 'existing' && (previewLoading.value || !preview.value)),
)

watch(
  () => props.item,
  (item) => {
    previewSequence += 1
    preview.value = null
    previewLoading.value = false
    localError.value = ''
    mode.value = 'create'
    idTouched.value = false
    const node = item?.itemKind === 'entity' ? (item.raw as KnowledgeNode) : null
    newProjectName.value = node?.name ?? ''
    newProjectId.value = projectIdFrom(node?.name ?? '')
    newProjectPurpose.value = node?.summary ?? ''
    reason.value = node ? `基于图谱节点“${node.name}”建立项目知识范围` : ''
    keepSourceRelation.value = true
    relationType.value = 'RELATED_TO'
    conflictResolution.value = 'defer'
    targetProjectId.value = availableProjects.value[0]?.project_id ?? ''
  },
  { immediate: true },
)

watch(newProjectName, (value) => {
  if (!idTouched.value) newProjectId.value = projectIdFrom(value)
})

watch(
  [mode, targetProjectId, () => props.item],
  () => {
    if (mode.value === 'existing') void loadPreview()
    else {
      previewSequence += 1
      preview.value = null
      previewLoading.value = false
      localError.value = ''
    }
  },
)

async function loadPreview() {
  const item = props.item
  if (!item || item.itemKind !== 'entity' || !targetProjectId.value) return
  const sequence = ++previewSequence
  previewLoading.value = true
  preview.value = null
  localError.value = ''
  try {
    const result = await postJson<ProjectActionPreview>(
      `/api/knowledge/entity/${encodeURIComponent(item.id)}/project-action/preview`,
      {
        personalSpaceId: props.personalSpaceId,
        targetProjectId: targetProjectId.value,
      },
    )
    if (sequence !== previewSequence || props.item?.id !== item.id) return
    preview.value = result
    if (result.match.kind === 'conflict') conflictResolution.value = 'defer'
  } catch (error) {
    if (sequence !== previewSequence) return
    fail(normalizeError(error))
    store.reportError(error)
  } finally {
    if (sequence === previewSequence) previewLoading.value = false
  }
}

async function submit() {
  const item = props.item
  if (!item || item.itemKind !== 'entity') return
  if (mode.value === 'create' && (!newProjectName.value.trim() || !newProjectId.value.trim())) {
    return fail('请填写项目名称和项目标识')
  }
  if (mode.value === 'existing' && !targetProjectId.value) return fail('请选择目标项目')
  if (mode.value === 'existing' && !preview.value) return fail('请等待重复与冲突检查完成')
  if (!reason.value.trim()) return fail('请填写操作说明')

  busy.value = true
  localError.value = ''
  try {
    const result = await postJson<ProjectActionResult>(
      `/api/knowledge/entity/${encodeURIComponent(item.id)}/project-action`,
      {
        personalSpaceId: props.personalSpaceId,
        mode: mode.value,
        targetProjectId: mode.value === 'existing' ? targetProjectId.value : null,
        newProjectId: mode.value === 'create' ? newProjectId.value.trim() : null,
        newProjectName: mode.value === 'create' ? newProjectName.value.trim() : null,
        newProjectPurpose: mode.value === 'create' ? newProjectPurpose.value.trim() : null,
        keepSourceRelation: Boolean(sourceProjectId.value && keepSourceRelation.value),
        relationType: relationType.value,
        conflictResolution: conflictResolution.value,
        reason: reason.value.trim(),
      },
    )
    const targetName = mode.value === 'create'
      ? newProjectName.value.trim()
      : selectedProject.value?.profile.name ?? '目标项目'
    emit('close')
    emit('saved', result, targetName)
  } catch (error) {
    fail(normalizeError(error))
    store.reportError(error)
  } finally {
    busy.value = false
  }
}

function projectIdFrom(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
  return normalized || 'new-project'
}

function normalizeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(text) as { message?: string; detail?: string }
    return parsed.message ?? parsed.detail ?? text
  } catch {
    return text
  }
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <dialog v-if="item" open class="project-dialog knowledge-project-dialog vue-dialog">
    <div class="project-dialog-shell">
      <header class="project-dialog-header">
        <div>
          <p class="eyebrow">PERSONAL PROJECT</p>
          <h3>建立项目知识范围</h3>
          <p>从当前节点创建个人项目，或让已有项目引用这条知识。</p>
        </div>
        <button class="secondary-action" type="button" @click="emit('close')">关闭</button>
      </header>

      <form class="knowledge-project-form" @submit.prevent="submit">
        <div class="knowledge-project-source">
          <span>来源节点</span>
          <strong>{{ rawNode?.name }}</strong>
          <p>{{ rawNode?.summary || '没有补充说明' }}</p>
        </div>

        <fieldset class="knowledge-project-mode">
          <legend>选择操作</legend>
          <label>
            <input v-model="mode" type="radio" value="create" />
            <span><strong>创建新项目</strong><small>以当前知识为起点建立独立范围</small></span>
          </label>
          <label :class="{ disabled: availableProjects.length === 0 }">
            <input
              v-model="mode"
              type="radio"
              value="existing"
              :disabled="availableProjects.length === 0"
            />
            <span><strong>加入已有项目</strong><small>先检查重复和已确认冲突</small></span>
          </label>
        </fieldset>

        <section v-if="mode === 'create'" class="knowledge-project-fields">
          <label>项目名称
            <input v-model="newProjectName" maxlength="512" required />
          </label>
          <label>项目标识
            <input
              v-model="newProjectId"
              maxlength="128"
              required
              @input="idTouched = true"
            />
          </label>
          <label class="full-width">项目用途
            <textarea v-model="newProjectPurpose" maxlength="4096" rows="3" />
          </label>
        </section>

        <section v-else class="knowledge-project-fields">
          <label class="full-width">目标个人项目
            <SearchableSelect
              v-model="targetProjectId"
              :options="availableProjectOptions"
              label="目标个人项目"
              searchable
              required
            />
          </label>
        </section>

        <section v-if="sourceProjectId" class="knowledge-project-relation">
          <label class="toggle-row">
            <input v-model="keepSourceRelation" type="checkbox" />
            <span>
              <strong>保留与来源项目的关系</strong>
              <small>当前知识的主要归属不会被覆盖</small>
            </span>
          </label>
          <label>项目关系
            <SearchableSelect
              v-model="relationType"
              :options="relationOptions"
              label="项目关系"
              :disabled="!keepSourceRelation"
            />
          </label>
        </section>

        <section class="knowledge-project-preview">
          <div>
            <span>{{ previewState.label }}</span>
            <strong>{{ previewState.title }}</strong>
            <p>{{ previewState.copy }}</p>
          </div>
          <div
            v-if="preview && ['exact_duplicate', 'conflict'].includes(preview.match.kind)"
            class="knowledge-project-compare"
          >
            <article>
              <span>当前节点</span>
              <strong>{{ preview.item_name }}</strong>
              <p>{{ preview.item_summary || '没有补充说明' }}</p>
            </article>
            <article>
              <span>目标项目已有内容</span>
              <strong>{{ preview.match.item_name || '目标项目内容' }}</strong>
              <p>{{ preview.match.item_summary || '没有补充说明' }}</p>
            </article>
          </div>
          <fieldset
            v-if="preview?.match.kind === 'conflict'"
            class="knowledge-project-conflict-options"
          >
            <legend>冲突处理</legend>
            <label><input v-model="conflictResolution" type="radio" value="defer" /> 暂不采用，保留待处理记录</label>
            <label><input v-model="conflictResolution" type="radio" value="keep_target" /> 保留目标项目现有内容</label>
            <label><input v-model="conflictResolution" type="radio" value="use_source" /> 使用当前来源内容</label>
            <label><input v-model="conflictResolution" type="radio" value="coexist" /> 允许两条内容并存</label>
          </fieldset>
        </section>

        <label class="knowledge-project-reason">操作说明
          <textarea v-model="reason" maxlength="2048" rows="3" required />
        </label>
        <p v-if="localError" class="publish-dialog-error" role="alert">{{ localError }}</p>
        <div class="knowledge-project-actions">
          <button class="secondary-action" type="button" @click="emit('close')">取消</button>
          <button class="primary-action" type="submit" :disabled="submitDisabled">
            {{ submitLabel }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>
