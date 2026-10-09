<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson, putJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
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
const displayName = ref('')
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

const editing = computed(() => Boolean(props.agent))
const projectOptions = computed(() => props.projects.map((project) => ({
  value: project.project_id,
  label: project.profile.name,
  meta: project.project_id,
})))
const statusOptions = computed(() => (['active', 'inactive', 'archived'] as const)
  .map((value) => ({ value, label: t(`projectAgents.status.${value}`) })))
// Temporary and coordinator identities cannot be created here; they only show when editing one.
const agentTypeOptions = computed(() => [
  ...(['durable', 'hr'] as const).map((value) => ({ value, label: t(`projectAgents.agentType.${value}`) })),
  ...(editing.value && (agentType.value === 'temporary' || agentType.value === 'coordinator')
    ? [{ value: agentType.value, label: t(`projectAgents.agentType.${agentType.value}`), disabled: true }]
    : []),
])
const selectionModeOptions = computed(() => (['flexible', 'locked'] as const)
  .map((value) => ({ value, label: t(`projectAgents.strategy.${value}`) })))
const strategyModeOptions = ['adaptive', 'fast', 'balanced', 'deep'].map((value) => ({ value, label: value }))

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
    displayName.value = agent?.profile.displayName ?? ''
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
      ...props.agent?.profile,
      name: agentName,
      responsibility: assignedResponsibility,
      capabilities: capabilityList,
      initialPreferences: preferenceList,
      status: status.value,
    }
    if (displayName.value.trim()) profile.displayName = displayName.value.trim()
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
    if (selectedProjectId && !editing.value) {
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
  <UiDialog :open="open" class="project-agent-dialog" size="lg" form :busy="busy" :error="error"
    :title="editing ? t('projectAgents.dialog.editTitle') : t('projectAgents.dialog.createTitle')"
    @close="emit('close')" @submit="save">
    <div class="project-agent-fields">
      <UiSelect v-model="projectId" field control-id="project-agent-project" :options="projectOptions" :label="t('projectAgents.fields.project')" :placeholder="t('projectAgents.dialog.projectPlaceholder')" :disabled="editing || busy" />
      <UiSelect v-model="status" field name="project-agent-status" :label="t('projectAgents.fields.status')" :options="statusOptions" :disabled="busy" />
      <UiSelect v-model="agentType" field name="project-agent-type" :label="t('projectAgents.fields.agentType')" :options="agentTypeOptions" :disabled="busy" />
      <label class="ui-field">{{ t('projectAgents.fields.agentId') }}
        <input v-model="agentId" name="project-agent-id" maxlength="128" required :disabled="editing || busy" :placeholder="t('projectAgents.dialog.agentIdPlaceholder')" />
        <small v-if="editing" class="ui-field-hint">{{ t('projectAgents.dialog.idLocked') }}</small>
      </label>
      <label class="ui-field">{{ t('attention.roleName') }}
        <input v-model="name" name="project-agent-name" maxlength="160" required :disabled="busy" :placeholder="t('projectAgents.dialog.namePlaceholder')" />
      </label>
      <label class="ui-field">{{ t('attention.displayName') }}
        <input v-model="displayName" name="project-agent-display-name" maxlength="160" :disabled="busy" />
      </label>
      <label class="ui-field">{{ t('projectAgents.fields.occupationEmoji') }}
        <input v-model="occupationEmoji" name="project-agent-occupation-emoji" maxlength="64" autocomplete="off" :disabled="busy" :placeholder="t('projectAgents.dialog.occupationEmojiPlaceholder')" />
      </label>
      <label class="ui-field project-agent-wide">{{ t('projectAgents.fields.responsibility') }}
        <textarea v-model="responsibility" name="project-agent-responsibility" maxlength="4096" rows="4" required :disabled="busy" :placeholder="t('projectAgents.dialog.responsibilityPlaceholder')" />
      </label>
      <label class="ui-field project-agent-wide">{{ t('projectAgents.fields.capabilities') }}
        <textarea v-model="capabilities" name="project-agent-capabilities" maxlength="8192" rows="4" :disabled="busy" :placeholder="t('projectAgents.dialog.capabilitiesPlaceholder')" />
      </label>
      <label class="ui-field project-agent-wide">{{ t('projectAgents.fields.initialPreferences') }}
        <textarea v-model="initialPreferences" name="project-agent-preferences" maxlength="8192" rows="4" :disabled="busy" :placeholder="t('projectAgents.dialog.preferencesPlaceholder')" />
      </label>
      <fieldset class="project-agent-wide project-agent-strategy">
        <legend>{{ t('projectAgents.fields.defaultModelStrategy') }}</legend>
        <UiSelect v-model="selectionMode" field name="project-agent-selection-mode" :label="t('projectAgents.fields.executorPolicy')" :options="selectionModeOptions" :disabled="busy" />
        <UiSelect v-model="strategyMode" field name="project-agent-model-mode" :label="t('projectAgents.fields.modelIntent')" :options="strategyModeOptions" :disabled="busy" />
        <label class="ui-field project-agent-wide">{{ t('projectAgents.fields.allowList') }}
          <textarea v-model="allowList" name="project-agent-allow-list" rows="3" :disabled="busy" :placeholder="t('projectAgents.dialog.allowListPlaceholder')" />
        </label>
        <small class="ui-field-hint project-agent-wide">{{ selectionMode === 'locked' ? t('projectAgents.strategy.lockedUnavailable') : t('projectAgents.strategy.providerNeutral') }}</small>
      </fieldset>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" :busy="busy" :busy-label="t('projectAgents.dialog.saving')">{{ editing ? t('projectAgents.dialog.saveEdit') : t('projectAgents.dialog.saveCreate') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.project-agent-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.project-agent-wide { grid-column: 1 / -1; }
.project-agent-strategy { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; min-width: 0; margin: 0; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.project-agent-strategy legend { padding: 0 6px; font-size: 12px; font-weight: 600; }
@media (max-width: 620px) {
  .project-agent-fields, .project-agent-strategy { grid-template-columns: 1fr; }
  .project-agent-wide { grid-column: auto; }
}
</style>
