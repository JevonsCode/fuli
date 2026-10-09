<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
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

const editing = computed(() => props.action !== 'assign')
const projectOptions = computed(() => props.projects.map((project) => ({
  value: project.project_id,
  label: project.profile.name,
  meta: project.project_id,
})))
const replacementOptions = computed(() => props.availableAgents
  .filter((agent) => agent.agentId !== props.agent?.agentId && agent.profile.status === 'active')
  .map((agent) => ({ value: agent.agentId, label: agent.profile.displayName || agent.profile.name, meta: agent.profile.name })))

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
  <UiDialog :open="open" class="project-agent-assignment-dialog" form :busy="busy" :error="error"
    :title="t(`projectAgents.assignmentDialog.${editing ? action : 'assign'}Title`)" @close="emit('close')" @submit="save">
    <div class="project-agent-assignment-fields">
      <UiSelect v-if="!editing" v-model="projectId" field control-id="project-agent-assignment-project" :options="projectOptions" :label="t('projectAgents.fields.project')" :placeholder="t('projectAgents.dialog.projectPlaceholder')" :disabled="busy" required />
      <label v-else class="ui-field">{{ t('projectAgents.fields.project') }}
        <input :value="props.assignment ? props.assignment.personalProjectId : ''" disabled />
      </label>
      <UiSelect v-if="editing && action === 'replace'" v-model="replacementAgentId" field control-id="project-agent-assignment-replacement" :options="replacementOptions" :label="t('projectAgents.assignmentDialog.replacement')" :placeholder="t('projectAgents.assignmentDialog.replacementPlaceholder')" :disabled="busy" required />
      <label v-if="!editing" class="ui-field project-agent-assignment-wide">{{ t('projectAgents.fields.responsibility') }}
        <textarea v-model="responsibility" rows="3" maxlength="4096" :disabled="busy" required />
      </label>
      <label v-if="!editing" class="ui-field">{{ t('projectAgents.fields.scope') }}
        <input v-model="scope" maxlength="4096" :disabled="busy" />
      </label>
      <label v-if="!editing" class="ui-field">{{ t('projectAgents.assignmentDialog.workKinds') }}
        <textarea v-model="workKinds" rows="3" :disabled="busy" :placeholder="t('projectAgents.assignmentDialog.workKindsPlaceholder')" />
      </label>
      <label class="ui-field project-agent-assignment-wide">{{ t('projectAgents.fields.reason') }}
        <textarea v-model="reason" rows="3" maxlength="2048" :disabled="busy" :placeholder="t('projectAgents.assignmentDialog.reasonPlaceholder')" required />
      </label>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" :busy="busy" :busy-label="t('projectAgents.assignmentDialog.saving')">{{ t(`projectAgents.assignmentDialog.${editing ? 'saveChange' : 'saveAssign'}`) }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.project-agent-assignment-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.project-agent-assignment-wide { grid-column: 1 / -1; }
@media (max-width: 620px) {
  .project-agent-assignment-fields { grid-template-columns: 1fr; }
  .project-agent-assignment-wide { grid-column: auto; }
}
</style>
