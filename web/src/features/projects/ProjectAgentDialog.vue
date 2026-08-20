<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson, putJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'
import type {
  PersonalProject,
  ProjectAgentModelMode,
  ProjectAgentModelSelectionMode,
  ProjectAgentAssignmentRecord,
  ProjectAgentRecord,
  ProjectAgentStatus,
  ProjectAgentType,
} from '@/types'

const props = defineProps<{
  open: boolean
  agent: ProjectAgentRecord | null
  projects: PersonalProject[]
  defaultProjectId?: string | null
  personalSpaceId?: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: [agent: ProjectAgentRecord]
}>()

const projectId = ref('')
const agentId = ref('')
const name = ref('')
const occupationEmoji = ref('')
const responsibility = ref('')
const capabilities = ref('')
const initialPreferences = ref('')
const status = ref<ProjectAgentStatus>('active')
const agentType = ref<ProjectAgentType>('durable')
const strategyMode = ref<ProjectAgentModelMode>('adaptive')
const selectionMode = ref<ProjectAgentModelSelectionMode>('flexible')
const allowList = ref('')
const busy = ref(false)
const error = ref('')
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(
  () => props.open,
  () => emit('close'),
)

const editing = computed(() => Boolean(props.agent))
const projectOptions = computed(() => props.projects.map((project) => ({
  value: project.project_id,
  label: project.profile.name,
  meta: project.project_id,
})))

watch(
  () => [props.open, props.agent, props.defaultProjectId] as const,
  ([open, agent, defaultProjectId]) => {
    if (!open) return
    projectId.value = agent?.personalProjectId
      ?? defaultProjectId
      ?? props.projects[0]?.project_id
      ?? ''
    agentId.value = agent?.agentId ?? ''
    name.value = agent?.profile.name ?? ''
    occupationEmoji.value = agent?.profile.occupationEmoji ?? ''
    responsibility.value = agent?.profile.responsibility ?? ''
    capabilities.value = (agent?.profile.capabilities ?? []).join('\n')
    initialPreferences.value = (agent?.profile.initialPreferences ?? []).join('\n')
    status.value = agent?.profile.status ?? 'active'
    agentType.value = agent?.profile.agentType ?? 'durable'
    strategyMode.value = agent?.profile.defaultModelStrategy?.mode ?? 'adaptive'
    selectionMode.value = agent?.profile.executorPolicy?.mode ?? 'flexible'
    const executorPolicy = agent?.profile.executorPolicy
    const executorIds = executorPolicy?.mode === 'locked'
      ? executorPolicy.lockedExecutorIds
      : executorPolicy?.preferredExecutorIds
    allowList.value = (executorIds?.length
      ? executorIds
      : executorPolicy?.allowList?.map(({ executorId }) => executorId) ?? []).join('\n')
    error.value = ''
  },
  { immediate: true },
)

function uniqueLines(value: string) {
  const lines = value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
  const keys = lines.map((item) => item.toLocaleLowerCase())
  return new Set(keys).size === keys.length ? lines : null
}

async function save() {
  if (busy.value) return
  const selectedProjectId = projectId.value.trim()
  const stableAgentId = agentId.value.trim()
  const agentName = name.value.trim()
  const agentOccupationEmoji = occupationEmoji.value.trim()
  const assignedResponsibility = responsibility.value.trim()
  if (!stableAgentId || !agentName || !assignedResponsibility) {
    error.value = t('projectAgents.dialog.required')
    return
  }
  const selectedProject = props.projects.find(
    ({ project_id }) => project_id === selectedProjectId,
  )
  if (selectedProjectId && !selectedProject) {
    error.value = t('projectAgents.dialog.projectUnavailable')
    return
  }
  if (agentOccupationEmoji && !isValidOccupationEmoji(agentOccupationEmoji)) {
    error.value = t('projectAgents.dialog.occupationEmojiInvalid')
    return
  }
  const personalSpaceId = selectedProject?.personal_space_id
    ?? props.personalSpaceId
    ?? props.agent?.personalSpaceId
  if (!personalSpaceId) {
    error.value = t('projectAgents.dialog.spaceUnavailable')
    return
  }
  const capabilityList = uniqueLines(capabilities.value)
  const preferenceList = uniqueLines(initialPreferences.value)
  if (!capabilityList || !preferenceList) {
    error.value = t('projectAgents.dialog.duplicate')
    return
  }

  const executorIds = uniqueLines(allowList.value)
  if (!executorIds || (selectionMode.value === 'locked' && !executorIds.length)) {
    error.value = t('projectAgents.dialog.duplicate')
    return
  }

  busy.value = true
  error.value = ''
  try {
    const profile: Record<string, unknown> = {
      name: agentName,
      responsibility: assignedResponsibility,
      capabilities: capabilityList,
      initialPreferences: preferenceList,
      status: status.value,
    }
    if (agentOccupationEmoji) profile.occupationEmoji = agentOccupationEmoji
    if (agentType.value !== 'durable') profile.agentType = agentType.value
    if (strategyMode.value !== 'adaptive') {
      profile.defaultModelStrategy = {
        mode: strategyMode.value,
      }
    }
    if (selectionMode.value !== 'flexible' || executorIds.length) {
      profile.executorPolicy = {
        mode: selectionMode.value,
        lockedExecutorIds: selectionMode.value === 'locked' ? executorIds : [],
        preferredExecutorIds: selectionMode.value === 'flexible' ? executorIds : [],
      }
    }
    const saved = await putJson<ProjectAgentRecord>('/api/project-agents', {
      personalSpaceId,
      personalProjectId: null,
      agentId: stableAgentId,
      profile,
    })
    let result = saved
    if (selectedProjectId) {
      const assignment = await postJson<ProjectAgentAssignmentRecord>('/api/project-agent-assignments', {
        personalSpaceId,
        personalProjectId: selectedProjectId,
        agentId: stableAgentId,
        idempotencyKey: `directory:${stableAgentId}:${Date.now()}`,
        responsibility: assignedResponsibility,
        capabilities: capabilityList,
        reason: t('projectAgents.dialog.initialAssignmentReason'),
      })
      result = { ...saved, personalProjectId: selectedProjectId, assignments: [assignment] }
    }
    emit('saved', result)
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : t('projectAgents.dialog.saveFailed')
  } finally {
    busy.value = false
  }
}

function isValidOccupationEmoji(value: string) {
  if (Array.from(value).length > 32 || /\s/u.test(value)) return false
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value))
  if (graphemes.length !== 1) return false
  const hasEmojiBase = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3/u.test(value)
  return hasEmojiBase
    && /^[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0E\uFE0F\u200D\u{E0020}-\u{E007F}#*0-9]+$/u.test(value)
}
</script>

<template>
  <dialog
    v-if="open"
    ref="dialogRef"
    class="project-agent-dialog vue-dialog"
    aria-modal="true"
    :aria-labelledby="'project-agent-dialog-title'"
    @cancel="onCancel"
    @keydown="onKeydown"
  >
    <form class="project-agent-dialog-shell" @submit.prevent="save">
      <header class="project-agent-dialog-header">
        <h3 id="project-agent-dialog-title">
          {{ editing ? t('projectAgents.dialog.editTitle') : t('projectAgents.dialog.createTitle') }}
        </h3>
        <button ref="initialFocusRef" data-dialog-initial-focus class="quiet-button" type="button" :disabled="busy" @click="emit('close')">
          {{ t('common.actions.close') }}
        </button>
      </header>

      <div class="project-agent-dialog-fields">
        <label>
          <span>{{ t('projectAgents.fields.project') }}</span>
          <SearchableSelect
            v-model="projectId"
            control-id="project-agent-project"
            :options="projectOptions"
            :label="t('projectAgents.fields.project')"
            :placeholder="t('projectAgents.dialog.projectPlaceholder')"
            :disabled="editing || busy"
          />
        </label>
        <label>
          <span>{{ t('projectAgents.fields.status') }}</span>
          <select v-model="status" name="project-agent-status" :disabled="busy">
            <option value="active">{{ t('projectAgents.status.active') }}</option>
            <option value="inactive">{{ t('projectAgents.status.inactive') }}</option>
            <option value="archived">{{ t('projectAgents.status.archived') }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('projectAgents.fields.agentType') }}</span>
          <select v-model="agentType" name="project-agent-type" :disabled="busy">
            <option value="durable">{{ t('projectAgents.agentType.durable') }}</option>
            <option value="hr">{{ t('projectAgents.agentType.hr') }}</option>
            <option v-if="editing && agentType === 'temporary'" value="temporary" disabled>{{ t('projectAgents.agentType.temporary') }}</option>
            <option v-if="editing && agentType === 'coordinator'" value="coordinator" disabled>{{ t('projectAgents.agentType.coordinator') }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('projectAgents.fields.agentId') }}</span>
          <input
            v-model="agentId"
            name="project-agent-id"
            maxlength="128"
            required
            :disabled="editing || busy"
            :placeholder="t('projectAgents.dialog.agentIdPlaceholder')"
          />
        </label>
        <label>
          <span>{{ t('projectAgents.fields.name') }}</span>
          <input
            v-model="name"
            name="project-agent-name"
            maxlength="160"
            required
            :disabled="busy"
            :placeholder="t('projectAgents.dialog.namePlaceholder')"
          />
        </label>
        <label>
          <span>{{ t('projectAgents.fields.occupationEmoji') }}</span>
          <input
            v-model="occupationEmoji"
            name="project-agent-occupation-emoji"
            maxlength="64"
            autocomplete="off"
            :disabled="busy"
            :placeholder="t('projectAgents.dialog.occupationEmojiPlaceholder')"
          />
        </label>
        <small v-if="editing" class="project-agent-id-note">
          {{ t('projectAgents.dialog.idLocked') }}
        </small>
        <label class="project-agent-wide-field">
          <span>{{ t('projectAgents.fields.responsibility') }}</span>
          <textarea
            v-model="responsibility"
            name="project-agent-responsibility"
            maxlength="4096"
            rows="4"
            required
            :disabled="busy"
            :placeholder="t('projectAgents.dialog.responsibilityPlaceholder')"
          />
        </label>
        <label class="project-agent-wide-field">
          <span>{{ t('projectAgents.fields.capabilities') }}</span>
          <textarea
            v-model="capabilities"
            name="project-agent-capabilities"
            maxlength="8192"
            rows="4"
            :disabled="busy"
            :placeholder="t('projectAgents.dialog.capabilitiesPlaceholder')"
          />
        </label>
        <label class="project-agent-wide-field">
          <span>{{ t('projectAgents.fields.initialPreferences') }}</span>
          <textarea
            v-model="initialPreferences"
            name="project-agent-preferences"
            maxlength="8192"
            rows="4"
            :disabled="busy"
            :placeholder="t('projectAgents.dialog.preferencesPlaceholder')"
          />
        </label>
        <fieldset class="project-agent-wide-field project-agent-strategy-fields">
          <legend>{{ t('projectAgents.fields.defaultModelStrategy') }}</legend>
          <label>
            <span>{{ t('projectAgents.fields.executorPolicy') }}</span>
            <select v-model="selectionMode" name="project-agent-selection-mode" :disabled="busy">
              <option value="flexible">{{ t('projectAgents.strategy.flexible') }}</option>
              <option value="locked">{{ t('projectAgents.strategy.locked') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('projectAgents.fields.modelIntent') }}</span>
            <select v-model="strategyMode" name="project-agent-model-mode" :disabled="busy">
              <option value="adaptive">adaptive</option>
              <option value="fast">fast</option>
              <option value="balanced">balanced</option>
              <option value="deep">deep</option>
            </select>
          </label>
          <label class="project-agent-wide-field">
            <span>{{ t('projectAgents.fields.allowList') }}</span>
            <textarea v-model="allowList" name="project-agent-allow-list" rows="3" :disabled="busy" :placeholder="t('projectAgents.dialog.allowListPlaceholder')" />
          </label>
          <small>{{ selectionMode === 'locked' ? t('projectAgents.strategy.lockedUnavailable') : t('projectAgents.strategy.providerNeutral') }}</small>
        </fieldset>
      </div>

      <p v-if="error" class="project-agent-dialog-error" role="alert">{{ error }}</p>

      <footer class="project-agent-dialog-actions">
        <button class="quiet-button" type="button" :disabled="busy" @click="emit('close')">
          {{ t('common.actions.cancel') }}
        </button>
        <button class="project-agent-primary-action" type="submit" :disabled="busy">
          {{ editing ? t('projectAgents.dialog.saveEdit') : t('projectAgents.dialog.saveCreate') }}
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

.project-agent-strategy-fields {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 12px;
  border: 1px solid #dfe5e0;
  border-radius: 9px;
}

.project-agent-strategy-fields legend {
  padding: 0 5px;
  color: #59665d;
  font-size: 10px;
  font-weight: 700;
}

.project-agent-strategy-fields > small {
  grid-column: 1 / -1;
  color: #818a84;
  font-size: 9px;
  line-height: 1.5;
}

.project-agent-id-note {
  margin-top: -8px;
  color: #7b847e;
  font-size: 10px;
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

@media (max-width: 720px) {
  .project-agent-dialog-fields {
    grid-template-columns: 1fr;
  }

  .project-agent-wide-field,
  .project-agent-id-note {
    grid-column: 1;
  }
}
</style>
