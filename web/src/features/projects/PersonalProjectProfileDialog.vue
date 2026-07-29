<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { putJson } from '@/api/client'
import type { PersonalProject } from '@/types'

type SourceDraft = {
  key: string
  kind: string
  title: string
  uri: string
  summary: string
  sensitivity: string
}

const props = defineProps<{
  project: PersonalProject | null
  materialType?: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: [project: PersonalProject]
}>()

const name = ref('')
const purpose = ref('')
const scope = ref('')
const technicalSummary = ref('')
const lifecycle = ref('planned')
const boundaries = ref('')
const sources = ref<SourceDraft[]>([])
const error = ref('')
const busy = ref(false)
const purposeField = ref<HTMLTextAreaElement | null>(null)
const scopeField = ref<HTMLTextAreaElement | null>(null)
const boundariesField = ref<HTMLTextAreaElement | null>(null)
const sourcesHeading = ref<HTMLElement | null>(null)

const materialLabel = computed(() => ({
  ProjectPurpose: '项目目标',
  ProjectScope: '项目范围',
  ProjectSource: '资料来源',
  ProjectBoundary: '项目边界',
  ProjectAssessment: '档案评估',
  AssessmentDimension: '评估维度',
  PersonalProject: '项目档案',
  RelatedPersonalProject: '关联项目',
}[props.materialType ?? ''] ?? '项目档案'))

const sourceKinds = [
  ['prd', 'PRD'],
  ['product_document', '产品文档'],
  ['technical_document', '技术文档'],
  ['frontend_repository', '前端仓库'],
  ['backend_repository', '后端仓库'],
  ['repository', '代码仓库'],
  ['design', '设计稿'],
  ['runbook', '运行手册'],
  ['monitoring', '监控'],
  ['issue_tracker', '事项追踪'],
  ['other', '其他'],
] as const

const sourceKindValues = new Set<string>(sourceKinds.map(([value]) => value))
const sensitivityValues = new Set(['normal', 'private', 'restricted'])

watch(
  () => [props.project, props.materialType] as const,
  async ([project]) => {
    if (!project) return
    const profile = project.profile
    name.value = profile.name
    purpose.value = profile.purpose ?? ''
    scope.value = profile.scope ?? ''
    technicalSummary.value = profile.technical_summary ?? ''
    lifecycle.value = profile.lifecycle ?? 'planned'
    boundaries.value = (profile.boundaries ?? [])
      .map((boundary) => String(boundary))
      .join('\n')
    sources.value = (profile.sources ?? []).map(normalizeSource)
    error.value = ''
    await nextTick()
    focusRelevantField()
  },
  { immediate: true },
)

function normalizeSource(source: Record<string, unknown>, index: number): SourceDraft {
  const kind = typeof source.kind === 'string' && sourceKindValues.has(source.kind)
    ? source.kind
    : 'other'
  const sensitivity = typeof source.sensitivity === 'string'
    && sensitivityValues.has(source.sensitivity)
    ? source.sensitivity
    : 'normal'
  return {
    key: text(source.key) || `source-${index + 1}`,
    kind,
    title: text(source.title) || text(source.name),
    uri: text(source.uri),
    summary: text(source.summary),
    sensitivity,
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function nullable(value: string) {
  return value.trim() || null
}

function boundaryLines() {
  return [...new Set(
    boundaries.value
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
  )].slice(0, 64)
}

function addSource() {
  sources.value.push({
    key: `source-${Date.now().toString(36)}-${sources.value.length + 1}`,
    kind: 'other',
    title: '',
    uri: '',
    summary: '',
    sensitivity: 'normal',
  })
}

function removeSource(index: number) {
  sources.value.splice(index, 1)
}

async function save() {
  if (!props.project || busy.value) return
  const projectName = name.value.trim()
  if (!projectName) {
    error.value = '请填写项目名称'
    return
  }
  if (sources.value.some((source) => !source.title.trim())) {
    error.value = '每条资料来源都需要名称'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const saved = await putJson<PersonalProject>('/api/personal-projects', {
      personalSpaceId: props.project.personal_space_id,
      projectId: props.project.project_id,
      profile: {
        name: projectName,
        purpose: nullable(purpose.value),
        scope: nullable(scope.value),
        technicalSummary: nullable(technicalSummary.value),
        lifecycle: lifecycle.value,
        sources: sources.value.map((source) => ({
          key: source.key,
          kind: source.kind,
          title: source.title.trim(),
          uri: nullable(source.uri),
          summary: nullable(source.summary),
          sensitivity: source.sensitivity,
        })),
        boundaries: boundaryLines(),
        assessment: props.project.profile.assessment ?? null,
      },
    })
    emit('saved', saved)
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '项目资料保存失败'
  } finally {
    busy.value = false
  }
}

function focusRelevantField() {
  if (props.materialType === 'ProjectPurpose') purposeField.value?.focus()
  else if (props.materialType === 'ProjectScope') scopeField.value?.focus()
  else if (props.materialType === 'ProjectBoundary') boundariesField.value?.focus()
  else if (props.materialType === 'ProjectSource') sourcesHeading.value?.focus()
}
</script>

<template>
  <dialog v-if="project" open class="project-profile-dialog vue-dialog">
    <form class="project-profile-dialog-shell" @submit.prevent="save">
      <header class="project-profile-dialog-header">
        <div>
          <p class="eyebrow">PROJECT MATERIAL</p>
          <h3>编辑{{ materialLabel }}</h3>
          <p>
            这些字段属于项目档案；保存后会重新生成关系图中的项目资料节点。
          </p>
        </div>
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          关闭
        </button>
      </header>

      <div class="project-profile-fields">
        <label>
          <span>项目名称</span>
          <input v-model="name" name="project-name" maxlength="160" required />
        </label>
        <label>
          <span>生命周期</span>
          <select v-model="lifecycle" name="project-lifecycle">
            <option value="planned">计划中</option>
            <option value="active">进行中</option>
            <option value="maintenance">维护中</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <label class="project-profile-wide-field">
          <span>项目目标</span>
          <textarea
            ref="purposeField"
            v-model="purpose"
            name="project-purpose"
            maxlength="4096"
            rows="4"
            placeholder="说明项目为什么存在、希望达成什么结果"
          />
        </label>
        <label class="project-profile-wide-field">
          <span>项目范围</span>
          <textarea
            ref="scopeField"
            v-model="scope"
            name="project-scope"
            maxlength="4096"
            rows="4"
            placeholder="说明项目包含的对象、流程或交付物"
          />
        </label>
        <label class="project-profile-wide-field">
          <span>技术摘要</span>
          <textarea
            v-model="technicalSummary"
            name="project-technical-summary"
            maxlength="4096"
            rows="4"
            placeholder="记录关键技术结构和运行方式"
          />
        </label>
        <label class="project-profile-wide-field">
          <span>项目边界</span>
          <textarea
            ref="boundariesField"
            v-model="boundaries"
            name="project-boundaries"
            maxlength="8192"
            rows="5"
            placeholder="每行一条明确不在本项目范围内的边界"
          />
          <small>每行一条；重复内容会在保存时合并。</small>
        </label>
      </div>

      <section class="project-source-editor">
        <div ref="sourcesHeading" class="project-source-editor-heading" tabindex="-1">
          <div>
            <h4>资料来源</h4>
            <p>保留资料类型、地址和敏感级别；这些内容会投影为图中的资料来源节点。</p>
          </div>
          <button class="secondary-action" type="button" @click="addSource">添加来源</button>
        </div>
        <div v-if="sources.length" class="project-source-list">
          <article v-for="(source, index) in sources" :key="source.key" class="project-source-row">
            <label>
              <span>名称</span>
              <input v-model="source.title" maxlength="512" required />
            </label>
            <label>
              <span>类型</span>
              <select v-model="source.kind">
                <option v-for="[value, label] in sourceKinds" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </label>
            <label class="project-source-wide-field">
              <span>地址</span>
              <input v-model="source.uri" maxlength="2048" placeholder="可选，例如仓库或文档地址" />
            </label>
            <label class="project-source-wide-field">
              <span>摘要</span>
              <textarea v-model="source.summary" maxlength="4096" rows="2" />
            </label>
            <label>
              <span>敏感级别</span>
              <select v-model="source.sensitivity">
                <option value="normal">普通</option>
                <option value="private">私有</option>
                <option value="restricted">受限</option>
              </select>
            </label>
            <button class="text-action project-source-remove" type="button" @click="removeSource(index)">
              移除
            </button>
          </article>
        </div>
        <p v-else class="project-source-empty">还没有登记资料来源。</p>
      </section>

      <p class="project-profile-state-note">
        项目资料不使用普通知识的“确认 / 失效 / 恢复”状态；要改变内容，请直接编辑档案。
      </p>
      <p v-if="error" class="project-profile-error" role="alert">{{ error }}</p>
      <footer class="project-profile-dialog-actions">
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          取消
        </button>
        <button class="primary-action" type="submit" :disabled="busy">
          {{ busy ? '正在保存…' : '保存项目资料' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
