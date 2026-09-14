<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'
import { employeeErrorMessage } from './catalog'
import type { EmployeeBoardItem } from './EmployeeTaskBoard.vue'

type Task = EmployeeBoardItem & { acceptanceCriteria?: string[] }
const props = defineProps<{ open: boolean; item: EmployeeBoardItem | null; projects: { id: string; name: string }[]; defaultProjectId?: string; personalSpaceId: string; canWrite: boolean }>()
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
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(() => props.open, close)
watch([() => props.open, () => props.item, () => props.personalSpaceId], () => { void load() }, { immediate: true })
async function call<T>(tool: string, args: Record<string, unknown>) {
  return postJson<T>('/api/employee-templates/jefa/call', { personalSpaceId: props.personalSpaceId, personalProjectId: project.value, tool, arguments: args })
}
async function load() {
  const current = ++version
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
  } catch (cause) { if (current === version) error.value = employeeErrorMessage(cause) }
  finally { if (current === version) loading.value = false }
}
async function save() {
  if (!valid.value || busy.value) return
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
    emit('saved'); emit('close')
  } catch (cause) { error.value = employeeErrorMessage(cause) }
  finally { busy.value = false }
}
function close() { if (!busy.value) emit('close') }
</script>

<template>
  <dialog ref="dialogRef" class="employee-dialog" aria-labelledby="employee-task-title" @cancel="onCancel" @keydown="onKeydown">
    <form class="employee-dialog-shell" @submit.prevent="save">
      <header><h2 id="employee-task-title">{{ t(item ? 'employees.task.detail' : 'employees.task.create') }}</h2><button type="button" :disabled="busy" :aria-label="t('employees.close')" @click="close">×</button></header>
      <div class="employee-dialog-body">
        <GrowthLoading v-if="loading" variant="compact" :label="t('employees.loadingTask')" />
        <div v-if="error" class="employee-dialog-error" role="alert"><p>{{ error }}</p><button type="button" :disabled="busy" @click="load">{{ t('employees.task.reload') }}</button></div>
        <template v-if="!loading">
          <label>{{ t('employees.task.project') }}<select v-model="project" :disabled="Boolean(item) || busy || !canWrite" required><option disabled value="">{{ t('employees.task.chooseProject') }}</option><option v-for="option in projects" :key="option.id" :value="option.id">{{ option.name }}</option></select></label>
          <label>{{ t('employees.task.title') }}<input ref="initialFocusRef" v-model="title" minlength="2" maxlength="180" required :readonly="!canWrite" :disabled="busy" /></label>
          <p v-if="baseline" class="employee-task-status">{{ t(`employees.allProjects.status.${baseline.status}`) }}</p>
          <label>{{ t('employees.task.summary') }}<textarea v-model="summary" rows="4" maxlength="2000" :readonly="!canWrite" :disabled="busy" /></label>
          <label>{{ t('employees.task.priority') }}<select v-model="priority" :disabled="!canWrite || busy"><option v-for="value in ['critical', 'high', 'medium', 'low']" :key="value" :value="value">{{ t(`employees.task.priorities.${value}`) }}</option></select></label>
          <label>{{ t('employees.task.criteria') }}<textarea v-model="criteria" rows="3" :readonly="!canWrite" :disabled="busy" /></label>
          <label>{{ t('employees.task.tags') }}<input v-model="tags" :readonly="!canWrite" :disabled="busy" /></label>
        </template>
      </div>
      <footer><button type="button" :disabled="busy" @click="close">{{ t('employees.close') }}</button><button v-if="canWrite" class="primary" type="submit" :disabled="!valid || busy"><GrowthLoading v-if="busy" variant="inline" :label="t('employees.task.saving')" /><template v-else>{{ t('employees.task.save') }}</template></button></footer>
    </form>
  </dialog>
</template>

<style src="./employee-dialog.css"></style>
