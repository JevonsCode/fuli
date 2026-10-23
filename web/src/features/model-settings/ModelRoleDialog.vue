<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { apiErrorReason, ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n'
import { UiDialog, UiSelect } from '@/ui'
import type { PersonalProject } from '@/types'
import {
  MODEL_PROTOCOLS, REASONING_EFFORTS, projectKey, roleDraft, roleName, rolesSharing, saveModelRole, withConnection, withProject,
  type ModelRoleId, type ModelRolesPayload, type RoleDraft,
} from './model'

// One role's model settings as a centred form. Saving sends the whole role
// with the revision it was read at; the server validates and refuses a file
// that changed meanwhile, and the page then shows what it read again.
const props = defineProps<{ role: ModelRoleId | null; payload: ModelRolesPayload; projects: readonly PersonalProject[] }>()
const emit = defineEmits<{ close: []; saved: [payload: ModelRolesPayload]; stale: [] }>()

const BUDGET_FIELDS = ['maxInputTokens', 'maxOutputTokens', 'timeoutSeconds', 'windowHours', 'maxTokensPerWindow'] as const
const draft = ref<RoleDraft | null>(null)
const saving = ref(false)
const error = ref('')
watch(() => props.role, (role) => {
  draft.value = role ? roleDraft(props.payload, role) : null
  error.value = ''
}, { immediate: true })

const name = computed(() => (props.role ? roleName(props.role) : ''))
const connectionOptions = computed(() => {
  const own = props.role && !props.payload.connections[props.role]
    ? [{ value: props.role, label: t('modelSettings.connectionNew', { id: props.role }) }] : []
  return [...Object.keys(props.payload.connections).map(id => ({ value: id, label: id })), ...own]
})
const sharing = computed(() => (props.role && draft.value
  ? rolesSharing(props.payload, draft.value.connectionId, props.role).map(roleName).join(', ') : ''))
const protocolOptions = computed(() => MODEL_PROTOCOLS.map(value => ({ value, label: t(`modelSettings.protocols.${value}`) })))
const effortOptions = computed(() => [{ value: '', label: t('modelSettings.reasoningDefault') },
  ...REASONING_EFFORTS.map(value => ({ value, label: value }))])
const wired = computed(() => (props.role ? props.payload.operations[props.role] ?? [] : []))
const projectChoices = computed(() => props.projects.filter(project => project.scope_type !== 'temporary')
  .map(project => ({ key: projectKey({ personalSpaceId: project.personal_space_id, personalProjectId: project.project_id }),
    project: { personalSpaceId: project.personal_space_id, personalProjectId: project.project_id }, label: project.profile.name })))
const approved = computed(() => new Set(draft.value?.approvedProjects.map(projectKey)))

function chooseConnection(id: string) {
  if (draft.value) draft.value = withConnection(draft.value, props.payload, id)
}

async function save() {
  if (!props.role || !draft.value) return
  saving.value = true
  error.value = ''
  try {
    emit('saved', await saveModelRole(props.role, draft.value, props.payload.revision))
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409 && cause.detail.includes('model_config_changed')) emit('stale')
    else error.value = apiErrorReason(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiDialog :open="Boolean(role && draft)" form size="lg" :busy="saving" :error="error"
    :title="t('modelSettings.editTitle', { name })" :description="t('modelSettings.editDescription')"
    data-model-role-dialog @close="emit('close')" @submit="save">
    <div v-if="draft" class="model-role-form">
      <Field orientation="horizontal">
        <Switch id="model-role-enabled" v-model="draft.enabled" :disabled="saving" />
        <FieldLabel for="model-role-enabled">{{ t('modelSettings.enabled') }}</FieldLabel>
      </Field>

      <div class="model-role-grid">
        <Field>
          <UiSelect :model-value="draft.connectionId" field :label="t('modelSettings.connection')" :options="connectionOptions"
            :disabled="saving" data-model-connection @update:model-value="chooseConnection" />
          <FieldDescription v-if="sharing">{{ t('modelSettings.sharedWith', { names: sharing }) }}</FieldDescription>
        </Field>
        <UiSelect v-model="draft.protocol" field :label="t('modelSettings.protocol')" :options="protocolOptions" :disabled="saving" />
        <Field class="model-role-wide">
          <FieldLabel for="model-role-endpoint">{{ t('modelSettings.endpoint') }}</FieldLabel>
          <Input id="model-role-endpoint" v-model="draft.endpoint" type="url" inputmode="url" autocomplete="off"
            placeholder="https://" :disabled="saving" data-model-endpoint />
        </Field>
        <Field>
          <FieldLabel for="model-role-model">{{ t('modelSettings.model') }}</FieldLabel>
          <Input id="model-role-model" v-model="draft.model" autocomplete="off" :disabled="saving" data-model-name />
        </Field>
        <UiSelect v-if="draft.protocol === 'openai_chat'" v-model="draft.reasoningEffort" field
          :label="t('modelSettings.reasoningEffort')" :options="effortOptions" :disabled="saving" />
        <Field class="model-role-wide">
          <FieldLabel for="model-role-secret-ref">{{ t('modelSettings.secretRef') }}</FieldLabel>
          <Input id="model-role-secret-ref" v-model="draft.secretRef" autocomplete="off" spellcheck="false"
            :disabled="saving" data-model-secret-ref />
          <FieldDescription>{{ t('modelSettings.secretRefHint') }}</FieldDescription>
        </Field>
      </div>

      <Field orientation="horizontal">
        <Checkbox id="model-role-priced" v-model="draft.priced" :disabled="saving" />
        <FieldLabel for="model-role-priced">{{ t('modelSettings.priced') }}</FieldLabel>
      </Field>
      <div v-if="draft.priced" class="model-role-grid">
        <Field>
          <FieldLabel for="model-role-currency">{{ t('modelSettings.currency') }}</FieldLabel>
          <Input id="model-role-currency" v-model="draft.currency" maxlength="3" autocomplete="off" :disabled="saving" />
        </Field>
        <Field>
          <FieldLabel for="model-role-input-price">{{ t('modelSettings.inputPrice') }}</FieldLabel>
          <Input id="model-role-input-price" v-model="draft.inputPrice" type="number" min="0" step="any" :disabled="saving" />
        </Field>
        <Field>
          <FieldLabel for="model-role-output-price">{{ t('modelSettings.outputPrice') }}</FieldLabel>
          <Input id="model-role-output-price" v-model="draft.outputPrice" type="number" min="0" step="any" :disabled="saving" />
        </Field>
      </div>

      <Field>
        <FieldLabel for="model-role-operations">{{ t('modelSettings.operations') }}</FieldLabel>
        <Input id="model-role-operations" v-model="draft.operations" autocomplete="off" spellcheck="false" :disabled="saving"
          data-model-operations />
        <FieldDescription>
          {{ t('modelSettings.operationsHint') }}
          {{ wired.length ? t('modelSettings.wired', { operations: wired.join(', ') }) : t('modelSettings.notWired') }}
        </FieldDescription>
      </Field>

      <fieldset class="model-role-fieldset">
        <legend>{{ t('modelSettings.egressProjectsLabel') }}</legend>
        <p v-if="!projectChoices.length" class="model-role-muted">{{ t('modelSettings.noProjects') }}</p>
        <div v-for="choice in projectChoices" :key="choice.key" class="model-role-check">
          <Checkbox :id="`model-role-project-${choice.key}`" :model-value="approved.has(choice.key)" :disabled="saving"
            data-model-egress-project @update:model-value="value => draft = withProject(draft!, choice.project, value === true)" />
          <Label :for="`model-role-project-${choice.key}`">{{ choice.label }}</Label>
        </div>
        <div class="model-role-check">
          <Checkbox id="model-role-unassigned" v-model="draft.allowUnassigned" :disabled="saving" />
          <Label for="model-role-unassigned">{{ t('modelSettings.allowUnassigned') }}</Label>
        </div>
      </fieldset>

      <div class="model-role-grid">
        <Field v-for="field in BUDGET_FIELDS" :key="field">
          <FieldLabel :for="`model-role-${field}`">{{ t(`modelSettings.${field}`) }}</FieldLabel>
          <Input :id="`model-role-${field}`" v-model="draft[field]" type="number" min="1" step="1" :disabled="saving"
            :data-model-budget="field" />
        </Field>
        <Field>
          <FieldLabel for="model-role-cost-cap">{{ t('modelSettings.maxCostPerWindow') }}</FieldLabel>
          <Input id="model-role-cost-cap" v-model="draft.maxCostPerWindow" type="number" min="0" step="any"
            :disabled="saving || !draft.priced" />
          <FieldDescription v-if="!draft.priced">{{ t('modelSettings.costNeedsPrice') }}</FieldDescription>
        </Field>
      </div>

      <Field orientation="horizontal">
        <Switch id="model-role-fallback" v-model="draft.fallbackToSession" :disabled="saving" />
        <FieldLabel for="model-role-fallback">{{ t('modelSettings.fallback') }}</FieldLabel>
      </Field>
    </div>
    <template #footer>
      <Button variant="ghost" :disabled="saving" @click="emit('close')">{{ t('modelSettings.cancel') }}</Button>
      <Button type="submit" :loading="saving" :loading-label="t('modelSettings.saving', { name })" data-model-save>
        {{ t('modelSettings.save') }}
      </Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.model-role-form { display: grid; gap: 16px; min-width: 0; }
.model-role-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px 16px; }
.model-role-wide { grid-column: 1 / -1; }
.model-role-fieldset { display: grid; gap: 8px; min-width: 0; margin: 0; padding: 0; border: 0; }
.model-role-fieldset legend { margin-bottom: 4px; font-size: 14px; font-weight: 500; }
.model-role-check { display: flex; align-items: center; gap: 10px; min-width: 0; overflow-wrap: anywhere; }
.model-role-muted { margin: 0; color: var(--color-muted); font-size: 13px; }
</style>
