<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import UiDialog from '@/ui/UiDialog.vue'
import UiSelect from '@/ui/UiSelect.vue'
import { t } from '@/i18n'
import { employeeErrorMessage, missingTask } from './catalog'
import type { EmployeeBoardItem } from './EmployeeTaskBoard.vue'
import { boardTaskPeekId, type BoardTaskRef } from './board-task-peek'

type Task = EmployeeBoardItem & { acceptanceCriteria?: string[] }
const props = defineProps<{ open: boolean; item: BoardTaskRef | null; projects: { id: string; name: string }[]; defaultProjectId?: string; personalSpaceId: string; canWrite: boolean }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const baseline = ref<Task | null>(null)
const project = ref('')
const title = ref('')
const summary = ref('')
const priority = ref('medium')
const criteria = ref('')
const tags = ref('')
let version = 0
let request = { signature: '', id: '' }
const valid = computed(() => props.canWrite && !loading.value && !error.value && Boolean(project.value) && title.value.trim().length >= 2)
const projectOptions = computed(() => props.projects.map(option => ({ value: option.id, label: option.name })))
const priorityOptions = computed(() => ['critical', 'high', 'medium', 'low'].map(value => ({ value, label: t(`employees.task.priorities.${value}`) })))
// The task is named by identity, so a new object for the same task does not reload over the person's edits.
watch([() => props.open, () => props.item && boardTaskPeekId(props.item), () => props.personalSpaceId], () => { void load() }, { immediate: true })
async function call<T>(tool: string, args: Record<string, unknown>) {
  return postJson<T>('/api/employee-templates/jefa/call', { personalSpaceId: props.personalSpaceId, personalProjectId: project.value, tool, arguments: args })
}
async function load() {
  const current = ++version
  // A save still running for the task shown before belongs to that task, not this one.
  busy.value = false
  if (!props.open) return
  error.value = ''; baseline.value = null; request = { signature: '', id: '' }
  project.value = props.item?.projectId ?? props.defaultProjectId ?? ''
  title.value = ''; summary.value = ''; priority.value = 'medium'; criteria.value = ''; tags.value = ''
  loading.value = Boolean(props.item)
  if (!props.item) return
  try {
    const result = await call<{ item: Task }>('get_task', { workItemId: props.item.id })
    if (current !== version) return
    if (result.item.id !== props.item.id || result.item.projectId !== project.value || !result.item.updatedAt) throw new Error(t('employees.loadError'))
    baseline.value = result.item
    title.value = result.item.title; summary.value = result.item.summary ?? ''; priority.value = result.item.priority ?? 'medium'
    criteria.value = result.item.acceptanceCriteria?.join('\n') ?? ''; tags.value = result.item.tags?.join(', ') ?? ''
  } catch (cause) { if (current === version) error.value = missingTask(cause) ? t('employees.task.notFound') : employeeErrorMessage(cause) }
  finally { if (current === version) loading.value = false }
}
// Each save is bound to the task (load generation) it was made for: a late
// answer after Back or another task opened neither closes nor writes into it.
async function save() {
  if (!valid.value || busy.value) return
  const current = version
  busy.value = true
  const task = { title: title.value.trim(), summary: summary.value.trim() || title.value.trim(), priority: priority.value,
    acceptanceCriteria: criteria.value.split('\n').map(value => value.trim()).filter(Boolean),
    tags: tags.value.split(/[,，]/).map(value => value.trim()).filter(Boolean) }
  const signature = JSON.stringify([project.value, baseline.value?.updatedAt, task])
  if (request.signature !== signature) request = { signature, id: `board-edit-${crypto.randomUUID()}` }
  try {
    if (baseline.value) {
      await call('update_tasks', { requestId: request.id, updates: [{ id: baseline.value.id, expectedUpdatedAt: baseline.value.updatedAt, ...task }] })
    } else await call('create_tasks', { messageId: request.id, tasks: [task] })
    // The board still refreshes for a late save: the change was made.
    emit('saved')
    if (current === version) emit('close')
  } catch (cause) { if (current === version) error.value = employeeErrorMessage(cause) }
  finally { if (current === version) busy.value = false }
}
function close() { if (!busy.value) emit('close') }
</script>

<template>
  <UiDialog :open="open" class="employee-dialog" :title="t(item ? 'employees.task.detail' : 'employees.task.create')" :busy="busy" form @close="close" @submit="save">
    <GrowthLoading v-if="loading" variant="compact" :label="t('employees.loadingTask')" />
    <div v-if="error" class="ui-dialog__error employee-dialog-error" role="alert"><p>{{ error }}</p><Button variant="outline" size="sm" :disabled="busy" @click="load">{{ t('employees.task.reload') }}</Button></div>
    <template v-if="!loading">
      <UiSelect v-model="project" field :label="t('employees.task.project')" :placeholder="t('employees.task.chooseProject')" :options="projectOptions" :disabled="Boolean(item) || busy || !canWrite" required />
      <label class="ui-field">{{ t('employees.task.title') }}<input v-model="title" autofocus minlength="2" maxlength="180" required :readonly="!canWrite" :disabled="busy" /></label>
      <p v-if="baseline" class="ui-meta">{{ t(`employees.allProjects.status.${baseline.status}`) }}</p>
      <label class="ui-field">{{ t('employees.task.summary') }}<textarea v-model="summary" rows="4" maxlength="2000" :readonly="!canWrite" :disabled="busy" /></label>
      <UiSelect v-model="priority" field :label="t('employees.task.priority')" :options="priorityOptions" :disabled="!canWrite || busy" />
      <label class="ui-field">{{ t('employees.task.criteria') }}<textarea v-model="criteria" rows="3" :readonly="!canWrite" :disabled="busy" /></label>
      <label class="ui-field">{{ t('employees.task.tags') }}<input v-model="tags" :readonly="!canWrite" :disabled="busy" /></label>
    </template>
    <template #footer>
      <Button variant="outline" :disabled="busy" @click="close">{{ t('employees.close') }}</Button>
      <Button v-if="canWrite" type="submit" :disabled="!valid" :loading="busy" :loading-label="t('employees.task.saving')">{{ t('employees.task.save') }}</Button>
    </template>
  </UiDialog>
</template>

