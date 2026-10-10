<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { putJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
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

const editingExecutor = computed(() => Boolean(props.executor))
const titleKey = computed(() => props.mode === 'executor'
  ? (editingExecutor.value ? 'executorEditTitle' : 'executorCreateTitle')
  : 'ruleCreateTitle')
const savingLabel = computed(() => props.mode === 'executor'
  ? t('projectAgents.routing.editor.savingExecutor')
  : t('projectAgents.routing.editor.savingRule'))
const scopeOptions = ['space', 'project', 'task'].map((value) => ({ value, label: value }))
const projectOptions = computed(() => props.projects.map((project) => ({
  value: project.project_id,
  label: project.profile.name,
  meta: project.project_id,
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
  <UiDialog :open="open" class="executor-routing-dialog" size="lg" form :busy="busy" :error="error"
    :title="t(`projectAgents.routing.editor.${titleKey}`)" @close="emit('close')" @submit="save">
    <div class="executor-routing-fields">
      <template v-if="mode === 'executor'">
        <label class="ui-field">{{ t('projectAgents.routing.editor.executorId') }}<input v-model="executorId" maxlength="128" :disabled="editingExecutor || busy" required /></label>
        <label class="ui-field">{{ t('projectAgents.routing.editor.displayName') }}<input v-model="displayName" maxlength="160" :disabled="busy" required /></label>
        <label class="ui-field">{{ t('projectAgents.routing.editor.executorKind') }}<input v-model="executorKind" maxlength="128" :disabled="busy" /></label>
        <label class="ui-field">{{ t('projectAgents.routing.editor.priority') }}<input v-model.number="priority" type="number" min="1" max="1000000" :disabled="busy" required /></label>
        <label class="ui-field executor-routing-wide">{{ t('projectAgents.routing.editor.capabilities') }}<textarea v-model="capabilities" rows="3" :disabled="busy" /></label>
        <label class="ui-check executor-routing-wide"><input v-model="healthRequired" type="checkbox" :disabled="busy" /><span>{{ t('projectAgents.routing.editor.healthRequired') }}</span></label>
        <p class="ui-meta executor-routing-wide">{{ t('projectAgents.routing.editor.evidenceNote') }}</p>
      </template>
      <template v-else>
        <UiSelect v-model="scope" field :label="t('projectAgents.routing.editor.scope')" :options="scopeOptions" :disabled="busy" />
        <label class="ui-field">{{ t('projectAgents.routing.editor.priority') }}<input v-model.number="priority" type="number" min="1" max="1000000" :disabled="busy" required /></label>
        <UiSelect v-if="scope === 'project' || scope === 'task'" v-model="projectId" field control-id="executor-rule-project" :options="projectOptions" :label="t('projectAgents.fields.project')" :disabled="busy" />
        <label v-if="scope === 'task'" class="ui-field">{{ t('projectAgents.routing.editor.taskId') }}<input v-model="taskId" maxlength="128" :disabled="busy" /></label>
        <label class="ui-field">{{ t('projectAgents.routing.editor.workKind') }}<input v-model="workKind" maxlength="128" :disabled="busy" required /></label>
        <label class="ui-field executor-routing-wide">{{ t('projectAgents.routing.editor.executorIds') }}<textarea v-model="executorAllowList" rows="3" :placeholder="t('projectAgents.routing.editor.executorIdsPlaceholder')" :disabled="busy" required /></label>
        <label class="ui-field executor-routing-wide">{{ t('projectAgents.routing.editor.requiredCapabilities') }}<textarea v-model="requiredCapabilities" rows="3" :disabled="busy" /></label>
        <label class="ui-field executor-routing-wide">{{ t('projectAgents.fields.reason') }}<textarea v-model="reason" rows="3" :disabled="busy" required /></label>
        <p class="ui-meta executor-routing-wide">{{ t('projectAgents.routing.editor.ruleNote') }}</p>
      </template>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" :busy="busy" :busy-label="savingLabel">{{ t('projectAgents.routing.editor.save') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.executor-routing-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.executor-routing-wide { grid-column: 1 / -1; }
.executor-routing-fields p { margin: 0; }
@media (max-width: 620px) {
  .executor-routing-fields { grid-template-columns: 1fr; }
  .executor-routing-wide { grid-column: auto; }
}
</style>
