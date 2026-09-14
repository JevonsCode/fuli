<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { putJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'
import type {
  PersonalProject,
  ProjectAgentExecutorRef,
  ProjectAgentRoutingRule,
} from '@/types'

type EditorMode = 'executor' | 'rule'

const props = withDefaults(defineProps<{
  open: boolean
  mode: EditorMode
  personalSpaceId: string
  executor?: ProjectAgentExecutorRef | null
  rule?: ProjectAgentRoutingRule | null
  projects?: PersonalProject[]
  availableExecutors?: ProjectAgentExecutorRef[]
}>(), {
  executor: null,
  rule: null,
  projects: () => [],
  availableExecutors: () => [],
})

const emit = defineEmits<{
  close: []
  saved: [value: ProjectAgentExecutorRef | ProjectAgentRoutingRule]
}>()

const executorId = ref('')
const displayName = ref('')
const executorKind = ref('external')
const capabilities = ref('')
const priority = ref(100)
const healthRequired = ref(false)
const scope = ref<ProjectAgentRoutingRule['scope']>('space')
const projectId = ref('')
const taskId = ref('')
const workKind = ref('')
const requiredCapabilities = ref('')
const executorAllowList = ref('')
const reason = ref('')
const busy = ref(false)
const error = ref('')
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(
  () => props.open,
  () => emit('close'),
)

const editingExecutor = computed(() => Boolean(props.executor))
const titleKey = computed(() => props.mode === 'executor'
  ? (editingExecutor.value ? 'executorEditTitle' : 'executorCreateTitle')
  : 'ruleCreateTitle')
const savingLabel = computed(() => props.mode === 'executor'
  ? t('projectAgents.routing.editor.savingExecutor')
  : t('projectAgents.routing.editor.savingRule'))
const projectOptions = computed(() => props.projects.map((project) => ({
  value: project.project_id,
  label: project.profile.name,
  meta: project.project_id,
})))
const executorOptions = computed(() => props.availableExecutors.map((executor) => ({
  value: executor.executorId,
  label: executor.displayName || executor.label || executor.executorId,
  meta: executor.executorId,
})))

watch(() => [props.open, props.mode, props.executor, props.rule] as const, ([open]) => {
  if (!open) return
  const executor = props.executor
  const rule = props.rule
  executorId.value = executor?.executorId ?? ''
  displayName.value = executor?.displayName ?? executor?.label ?? ''
  executorKind.value = executor?.executorKind ?? 'external'
  capabilities.value = executor?.capabilities?.join('\n') ?? ''
  priority.value = executor?.globalPriority ?? rule?.priority ?? 100
  healthRequired.value = executor?.healthRequired === true
  scope.value = rule?.scope ?? 'space'
  projectId.value = rule?.personalProjectId ?? ''
  taskId.value = rule?.taskId ?? ''
  workKind.value = rule?.workKind ?? ''
  requiredCapabilities.value = rule?.requiredCapabilities?.join('\n') ?? ''
  executorAllowList.value = rule?.executorIds?.join('\n') ?? ''
  reason.value = ''
  error.value = ''
}, { immediate: true })

function lines(value: string) {
  return [...new Set(value.split('\n').map((item) => item.trim()).filter(Boolean))]
}

function idempotencyKey(prefix: string) {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${uuid}`
}

async function save() {
  if (busy.value) return
  const capabilityList = lines(capabilities.value)
  const normalizedReason = reason.value.trim()
  if (props.mode === 'executor') {
    if (!executorId.value.trim() || !displayName.value.trim() || priority.value < 1) {
      error.value = t('projectAgents.routing.editor.executorRequired')
      return
    }
  } else if (!workKind.value.trim() || !lines(executorAllowList.value).length || !normalizedReason) {
    error.value = t('projectAgents.routing.editor.ruleRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    if (props.mode === 'executor') {
      const saved = await putJson<ProjectAgentExecutorRef>('/api/executors', {
        personalSpaceId: props.personalSpaceId,
        executorId: executorId.value.trim(),
        displayName: displayName.value.trim(),
        executorKind: executorKind.value.trim() || 'external',
        capabilities: capabilityList,
        advertisedModels: props.executor?.advertisedModels ?? props.executor?.availableModels ?? [],
        globalPriority: priority.value,
        healthRequired: healthRequired.value,
        expectedRevision: props.executor?.revision,
        idempotencyKey: idempotencyKey('executor-directory'),
      })
      emit('saved', saved)
    } else {
      const saved = await putJson<ProjectAgentRoutingRule>('/api/executor-routing-rules', {
        personalSpaceId: scope.value === 'global' ? undefined : props.personalSpaceId,
        scope: scope.value,
        personalProjectId: scope.value === 'project' || scope.value === 'task' ? projectId.value || undefined : undefined,
        taskId: scope.value === 'task' ? taskId.value || undefined : undefined,
        workKind: workKind.value.trim(),
        requiredCapabilities: lines(requiredCapabilities.value),
        executorIds: lines(executorAllowList.value),
        priority: priority.value,
        reason: normalizedReason,
        idempotencyKey: idempotencyKey('executor-rule'),
      })
      emit('saved', saved)
    }
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('projectAgents.routing.editor.saveFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dialogRef" v-if="open" class="project-agent-dialog vue-dialog" aria-modal="true" aria-labelledby="executor-routing-dialog-title" @cancel="onCancel" @keydown="onKeydown">
    <form class="project-agent-dialog-shell" @submit.prevent="save">
      <header class="project-agent-dialog-header">
        <h3 id="executor-routing-dialog-title">{{ t(`projectAgents.routing.editor.${titleKey}`) }}</h3>
        <button ref="initialFocusRef" data-dialog-initial-focus class="quiet-button" type="button" :disabled="busy" @click="emit('close')">{{ t('common.actions.close') }}</button>
      </header>
      <div class="project-agent-dialog-fields">
        <template v-if="mode === 'executor'">
          <label><span>{{ t('projectAgents.routing.editor.executorId') }}</span><input v-model="executorId" maxlength="128" :disabled="editingExecutor || busy" required /></label>
          <label><span>{{ t('projectAgents.routing.editor.displayName') }}</span><input v-model="displayName" maxlength="160" :disabled="busy" required /></label>
          <label><span>{{ t('projectAgents.routing.editor.executorKind') }}</span><input v-model="executorKind" maxlength="128" :disabled="busy" /></label>
          <label><span>{{ t('projectAgents.routing.editor.priority') }}</span><input v-model.number="priority" type="number" min="1" max="1000000" :disabled="busy" required /></label>
          <label class="project-agent-wide-field"><span>{{ t('projectAgents.routing.editor.capabilities') }}</span><textarea v-model="capabilities" rows="3" :disabled="busy" /></label>
          <label class="project-agent-dialog-check"><input v-model="healthRequired" type="checkbox" :disabled="busy" /> <span>{{ t('projectAgents.routing.editor.healthRequired') }}</span></label>
          <p class="project-agent-dialog-note project-agent-wide-field">{{ t('projectAgents.routing.editor.evidenceNote') }}</p>
        </template>
        <template v-else>
          <label><span>{{ t('projectAgents.routing.editor.scope') }}</span><select v-model="scope" :disabled="busy"><option value="space">space</option><option value="project">project</option><option value="task">task</option></select></label>
          <label><span>{{ t('projectAgents.routing.editor.priority') }}</span><input v-model.number="priority" type="number" min="1" max="1000000" :disabled="busy" required /></label>
          <label v-if="scope === 'project' || scope === 'task'"><span>{{ t('projectAgents.fields.project') }}</span><SearchableSelect v-model="projectId" control-id="executor-rule-project" :options="projectOptions" :label="t('projectAgents.fields.project')" :disabled="busy" /></label>
          <label v-if="scope === 'task'"><span>{{ t('projectAgents.routing.editor.taskId') }}</span><input v-model="taskId" maxlength="128" :disabled="busy" /></label>
          <label><span>{{ t('projectAgents.routing.editor.workKind') }}</span><input v-model="workKind" maxlength="128" :disabled="busy" required /></label>
          <label class="project-agent-wide-field"><span>{{ t('projectAgents.routing.editor.executorIds') }}</span><textarea v-model="executorAllowList" rows="3" :placeholder="t('projectAgents.routing.editor.executorIdsPlaceholder')" :disabled="busy" required /></label>
          <label class="project-agent-wide-field"><span>{{ t('projectAgents.routing.editor.requiredCapabilities') }}</span><textarea v-model="requiredCapabilities" rows="3" :disabled="busy" /></label>
          <label class="project-agent-wide-field"><span>{{ t('projectAgents.fields.reason') }}</span><textarea v-model="reason" rows="3" :disabled="busy" required /></label>
          <p class="project-agent-dialog-note project-agent-wide-field">{{ t('projectAgents.routing.editor.ruleNote') }}</p>
        </template>
      </div>
      <p v-if="error" class="project-agent-dialog-error" role="alert">{{ error }}</p>
      <footer class="project-agent-dialog-actions">
        <button class="quiet-button" type="button" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</button>
        <button class="project-agent-primary-action" type="submit" :disabled="busy">
          <GrowthLoading v-if="busy" variant="inline" :label="savingLabel" />
          <span v-else>{{ t('projectAgents.routing.editor.save') }}</span>
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.project-agent-dialog {
  width: min(760px, calc(100vw - 64px));
  max-height: calc(100vh - 64px);
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 12px;
  background: transparent;
}

.project-agent-dialog-shell {
  max-height: calc(100vh - 64px);
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #d5dcd7;
  border-radius: 12px;
  background: #fbfcfb;
  box-shadow: 0 18px 48px rgb(33 45 38 / 18%);
}

.project-agent-dialog-header,
.project-agent-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
}

.project-agent-dialog-header {
  border-bottom: 1px solid #e1e6e2;
}

.project-agent-dialog-header h3 {
  color: #283a31;
  font-size: 17px;
}

.project-agent-dialog-fields {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  padding: 20px;
  overflow: auto;
}

.project-agent-dialog-fields label {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 6px;
  color: #626d66;
  font-size: 11px;
  font-weight: 650;
}

.project-agent-dialog-fields input,
.project-agent-dialog-fields select,
.project-agent-dialog-fields textarea {
  width: 100%;
  border: 1px solid #ccd5ce;
  border-radius: 8px;
  background: #fff;
  color: #28342d;
  padding: 9px 10px;
  font-size: 12px;
  line-height: 1.5;
}

.project-agent-dialog-fields textarea {
  resize: vertical;
}

.project-agent-dialog-fields input:focus-visible,
.project-agent-dialog-fields select:focus-visible,
.project-agent-dialog-fields textarea:focus-visible {
  outline: 2px solid #91a398;
  outline-offset: 1px;
}

.project-agent-wide-field,
.project-agent-id-note {
  grid-column: 1 / -1;
}

.project-agent-dialog-error {
  margin: 0 20px;
  color: #8b3f38;
  font-size: 11px;
}

.project-agent-dialog-actions {
  justify-content: flex-end;
  border-top: 1px solid #e1e6e2;
}

.project-agent-primary-action {
  border: 0;
  border-radius: 8px;
  background: #344c3d;
  color: #fff;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 700;
}

.project-agent-primary-action:hover {
  background: #2b4234;
}

.project-agent-primary-action:focus-visible {
  outline: 2px solid #91a398;
  outline-offset: 2px;
}

.project-agent-primary-action:disabled,
.project-agent-dialog-fields :disabled {
  cursor: not-allowed;
  opacity: .6;
}

.project-agent-dialog-check { display: flex !important; align-items: center; gap: 7px !important; }
.project-agent-dialog-check input { width: auto !important; }
.project-agent-dialog-note { color: #7b857e; font-size: 10px; line-height: 1.55; }
</style>
