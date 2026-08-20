<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'
import type { PersonalProject, ProjectAgentAssignmentRecord, ProjectAgentRecord } from '@/types'

type AssignmentAction = 'assign' | 'end' | 'replace'

const props = withDefaults(defineProps<{
  open: boolean
  agent: ProjectAgentRecord | null
  assignment?: ProjectAgentAssignmentRecord | null
  action?: AssignmentAction
  projects: PersonalProject[]
  availableAgents?: ProjectAgentRecord[]
  defaultProjectId?: string | null
}>(), {
  assignment: null,
  action: 'assign',
  availableAgents: () => [],
  defaultProjectId: null,
})

const emit = defineEmits<{
  close: []
  saved: [assignment: ProjectAgentAssignmentRecord]
  changed: []
}>()

const projectId = ref('')
const replacementAgentId = ref('')
const responsibility = ref('')
const scope = ref('')
const workKinds = ref('')
const reason = ref('')
const busy = ref(false)
const error = ref('')
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(
  () => props.open,
  () => emit('close'),
)

const editing = computed(() => props.action !== 'assign')
const projectOptions = computed(() => props.projects.map((project) => ({
  value: project.project_id,
  label: project.profile.name,
  meta: project.project_id,
})))
const replacementOptions = computed(() => props.availableAgents
  .filter((agent) => agent.agentId !== props.agent?.agentId && agent.profile.status === 'active')
  .map((agent) => ({ value: agent.agentId, label: agent.profile.name, meta: agent.agentId })))

watch(() => [props.open, props.agent, props.assignment, props.action, props.defaultProjectId], () => {
  if (!props.open) return
  projectId.value = props.assignment?.personalProjectId ?? props.defaultProjectId ?? props.projects[0]?.project_id ?? ''
  replacementAgentId.value = ''
  responsibility.value = props.assignment?.responsibility ?? props.agent?.profile.responsibility ?? ''
  scope.value = props.assignment?.scope ?? ''
  workKinds.value = props.assignment?.workKinds?.join('\n') ?? ''
  reason.value = ''
  error.value = ''
}, { immediate: true })

async function save() {
  if (!props.agent) return
  error.value = ''
  const normalizedReason = reason.value.trim()
  const normalizedResponsibility = responsibility.value.trim()
  if (!normalizedReason || (props.action === 'assign' && !normalizedResponsibility)) {
    error.value = t('projectAgents.assignmentDialog.required')
    return
  }
  if (props.action === 'replace' && !replacementAgentId.value) {
    error.value = t('projectAgents.assignmentDialog.replacementRequired')
    return
  }
  busy.value = true
  try {
    if (props.action === 'assign') {
      const saved = await postJson<ProjectAgentAssignmentRecord>('/api/project-agent-assignments', {
        personalSpaceId: props.agent.personalSpaceId,
        personalProjectId: projectId.value,
        agentId: props.agent.agentId,
        idempotencyKey: createIdempotencyKey(),
        responsibility: normalizedResponsibility,
        workKinds: splitLines(workKinds.value),
        capabilities: [],
        reason: normalizedReason,
      })
      emit('saved', saved)
    } else {
      if (!props.assignment) return
      const path = `/api/project-agent-assignments/${encodeURIComponent(props.assignment.assignmentId)}/${props.action}`
      const body = props.action === 'replace'
        ? {
          personalSpaceId: props.agent.personalSpaceId,
          personalProjectId: props.assignment.personalProjectId,
          assignmentId: props.assignment.assignmentId,
          expectedRevision: props.assignment.revision ?? 0,
          replacementAgentId: replacementAgentId.value,
          idempotencyKey: createIdempotencyKey(),
          responsibility: normalizedResponsibility || props.assignment.responsibility,
          workKinds: splitLines(workKinds.value),
          capabilities: props.assignment.capabilities ?? [],
          reason: normalizedReason,
        }
        : {
          personalSpaceId: props.agent.personalSpaceId,
          personalProjectId: props.assignment.personalProjectId,
          assignmentId: props.assignment.assignmentId,
          expectedRevision: props.assignment.revision ?? 0,
          reason: normalizedReason,
        }
      await postJson(path, body)
      emit('changed')
    }
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('projectAgents.assignmentDialog.saveFailed')
  } finally {
    busy.value = false
  }
}

function splitLines(value: string) {
  return [...new Set(value.split('\n').map((item) => item.trim()).filter(Boolean))]
}

function createIdempotencyKey() {
  const randomUuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `project-agent-assignment-${randomUuid}`
}
</script>

<template>
  <dialog ref="dialogRef" v-if="open" class="project-agent-assignment-dialog vue-dialog" aria-modal="true" aria-labelledby="project-agent-assignment-dialog-title" @cancel="onCancel" @keydown="onKeydown">
    <form class="project-agent-assignment-dialog-shell" @submit.prevent="save">
      <header class="project-agent-assignment-dialog-header">
        <h3 id="project-agent-assignment-dialog-title">
          {{ t(`projectAgents.assignmentDialog.${editing ? action : 'assign'}Title`) }}
        </h3>
        <button ref="initialFocusRef" data-dialog-initial-focus class="quiet-button" type="button" :disabled="busy" @click="emit('close')">{{ t('common.actions.close') }}</button>
      </header>
      <div class="project-agent-assignment-dialog-fields">
        <label v-if="!editing">
          <span>{{ t('projectAgents.fields.project') }}</span>
          <SearchableSelect v-model="projectId" control-id="project-agent-assignment-project" :options="projectOptions" :label="t('projectAgents.fields.project')" :placeholder="t('projectAgents.dialog.projectPlaceholder')" :disabled="busy" required />
        </label>
        <label v-else>
          <span>{{ t('projectAgents.fields.project') }}</span>
          <input :value="props.assignment ? props.assignment.personalProjectId : ''" disabled />
        </label>
        <label v-if="editing && action === 'replace'">
          <span>{{ t('projectAgents.assignmentDialog.replacement') }}</span>
          <SearchableSelect v-model="replacementAgentId" control-id="project-agent-assignment-replacement" :options="replacementOptions" :label="t('projectAgents.assignmentDialog.replacement')" :placeholder="t('projectAgents.assignmentDialog.replacementPlaceholder')" :disabled="busy" required />
        </label>
        <label v-if="!editing" class="project-agent-assignment-wide-field">
          <span>{{ t('projectAgents.fields.responsibility') }}</span>
          <textarea v-model="responsibility" rows="3" maxlength="4096" :disabled="busy" required />
        </label>
        <label v-if="!editing">
          <span>{{ t('projectAgents.fields.scope') }}</span>
          <input v-model="scope" maxlength="4096" :disabled="busy" />
        </label>
        <label v-if="!editing">
          <span>{{ t('projectAgents.assignmentDialog.workKinds') }}</span>
          <textarea v-model="workKinds" rows="3" :disabled="busy" :placeholder="t('projectAgents.assignmentDialog.workKindsPlaceholder')" />
        </label>
        <label class="project-agent-assignment-wide-field">
          <span>{{ t('projectAgents.fields.reason') }}</span>
          <textarea v-model="reason" rows="3" maxlength="2048" :disabled="busy" :placeholder="t('projectAgents.assignmentDialog.reasonPlaceholder')" required />
        </label>
      </div>
      <p v-if="error" class="project-agent-assignment-dialog-error" role="alert">{{ error }}</p>
      <footer class="project-agent-assignment-dialog-actions">
        <button class="quiet-button" type="button" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</button>
        <button class="project-agent-primary-action" type="submit" :disabled="busy">{{ t(`projectAgents.assignmentDialog.${editing ? 'saveChange' : 'saveAssign'}`) }}</button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.project-agent-assignment-dialog { width: min(620px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 0; border: 0; border-radius: 12px; background: transparent; }
.project-agent-assignment-dialog-shell { max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #d5dcd7; border-radius: 12px; background: #fbfcfb; box-shadow: 0 18px 48px rgb(33 45 38 / 18%); }
.project-agent-assignment-dialog-header, .project-agent-assignment-dialog-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; }
.project-agent-assignment-dialog-header { border-bottom: 1px solid #e1e6e2; }.project-agent-assignment-dialog-header h3 { color: #283a31; font-size: 16px; }
.project-agent-assignment-dialog-fields { min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 18px; overflow: auto; }.project-agent-assignment-dialog-fields label { display: grid; gap: 6px; color: #626d66; font-size: 11px; font-weight: 650; }.project-agent-assignment-dialog-fields input, .project-agent-assignment-dialog-fields textarea { width: 100%; border: 1px solid #ccd5ce; border-radius: 8px; background: #fff; color: #28342d; padding: 8px 9px; font-size: 12px; line-height: 1.5; }.project-agent-assignment-dialog-fields textarea { resize: vertical; }.project-agent-assignment-dialog-fields input:focus-visible, .project-agent-assignment-dialog-fields textarea:focus-visible { outline: 2px solid #91a398; outline-offset: 1px; }.project-agent-assignment-wide-field { grid-column: 1 / -1; }.project-agent-assignment-dialog-error { margin: 0 18px; color: #8b3f38; font-size: 11px; }.project-agent-assignment-dialog-actions { border-top: 1px solid #e1e6e2; justify-content: flex-end; }.project-agent-primary-action { border: 0; border-radius: 8px; background: #344c3d; color: #fff; padding: 8px 13px; font-size: 11px; font-weight: 700; }.project-agent-primary-action:focus-visible { outline: 2px solid #91a398; outline-offset: 2px; }
@media (max-width: 620px) { .project-agent-assignment-dialog-fields { grid-template-columns: 1fr; }.project-agent-assignment-wide-field { grid-column: auto; } }
</style>
