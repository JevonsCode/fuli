<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { OptionCombobox } from '@/components/ui/combobox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OptionSelect } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { t, currentLocale } from '@/i18n'
import { UiDialog, UiSegmented } from '@/ui'
import type { PersonalProject } from '@/types'
import ModelKeyEntry from './ModelKeyEntry.vue'
import ModelSecretRefField from './ModelSecretRefField.vue'
import { modelListReason, modelListRequest, orderModels } from './model-list'
import { useEndpointModels } from './useEndpointModels'
import {
  MODEL_PROTOCOLS, REASONING_EFFORTS, SEMANTIC_PRESETS, SEMANTIC_ROLE, configConflict, endpointSuggestions, knownKeyReferences, projectKey, roleDraft, roleName,
  rolesSharing, saveModelRole, semanticPreset, validKeyReference, withConnection, withProject, withSemanticPreset,
  type ConfigConflict, type ModelRoleId, type ModelRolesPayload, type RoleDraft, type SemanticPreset, modelGuideUrl } from './model'

// One role's model settings as a centred form. Saving sends the whole role
// with the revision it was read at; the server validates and refuses a file
// that changed meanwhile, and the page then shows what it read again.
const props = defineProps<{ role: ModelRoleId | null; payload: ModelRolesPayload; projects: readonly PersonalProject[] }>()
const emit = defineEmits<{ close: []; saved: [payload: ModelRolesPayload]; conflict: [code: ConfigConflict] }>()

const BUDGET_FIELDS = ['maxInputTokens', 'maxOutputTokens', 'timeoutSeconds', 'windowHours', 'maxTokensPerWindow'] as const
const draft = ref<RoleDraft | null>(null)
const saving = ref(false)
// A file that stopped validating while the form was open: it is read again
// and nothing here can be saved until it is repaired.
const locked = computed(() => props.payload.state === 'invalid')
const frozen = computed(() => saving.value || locked.value)
// Off means the current chat's model does the work: nothing below applies.
const inactive = computed(() => frozen.value || !draft.value?.enabled)
const shownError = computed(() => (locked.value
  ? t('modelSettings.invalidWhileEditing', { error: props.payload.error ?? '' }) : error.value))
const error = ref('')
// 语义搜索 shows only its address, model, key and projects: its protocol is
// fixed, and it has no task types, budget or session to fall back to.
const semantic = computed(() => props.role === SEMANTIC_ROLE)
// The models the typed address lists, asked while the form can be edited; typing any name stays possible.
const { models: listed, refresh: refreshModels } = useEndpointModels(() => (draft.value && !inactive.value
  ? modelListRequest(draft.value.protocol, draft.value.endpoint, draft.value.secretRef) : null))
const modelOptions = computed(() => orderModels(listed.value.ids, semantic.value).map(id => ({ value: id, label: id })))
const endpointOptions = computed(() => (draft.value ? endpointSuggestions(draft.value.protocol) : []))
const modelListText = computed(() => {
  const state = listed.value
  if (inactive.value) return ''
  if (state.status === 'idle') return t('modelSettings.modelList.needsEndpoint')
  if (state.status === 'failed') return t('modelSettings.modelList.failed', { reason: modelListReason(state.code) })
  if (state.status === 'ok') {
    return state.ids.length ? t('modelSettings.modelList.found', { count: state.ids.length })
      : t('modelSettings.modelList.empty')
  }
  return ''
})
watch(() => props.role, (role) => {
  draft.value = role ? roleDraft(props.payload, role) : null
  error.value = ''
  refreshModels()
}, { immediate: true })

const name = computed(() => (props.role ? roleName(props.role) : ''))
const presetOptions = computed(() => SEMANTIC_PRESETS.map(value => ({ value, label: t(`modelSettings.semantic.presets.${value}`) })))
const preset = computed({
  get: () => semanticPreset(draft.value?.endpoint ?? ''),
  set(next: SemanticPreset) { if (draft.value) draft.value = withSemanticPreset(draft.value, next) },
})
const enabledHint = computed(() => (semantic.value
  ? t(draft.value?.enabled ? 'modelSettings.semantic.enabledOnHint' : 'modelSettings.semantic.enabledOffHint')
  : t(draft.value?.enabled ? 'modelSettings.enabledOnHint' : 'modelSettings.enabledOffHint', { name: name.value })))
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
const projectQuery = ref('')
const shownProjects = computed(() => {
  const query = projectQuery.value.trim().toLowerCase()
  return query ? projectChoices.value.filter(choice => choice.label.toLowerCase().includes(query)) : projectChoices.value
})
const savedKeys = ref<string[]>([])
// Dreaming and retrieval terms are two of Astro's task types; each switch is that entry in the list.
const operationSwitch = (name: string) => computed({
  get: () => operationList(draft.value?.operations).includes(name),
  set(on: boolean) {
    if (!draft.value) return
    const others = operationList(draft.value.operations).filter(operation => operation !== name)
    draft.value = { ...draft.value, operations: (on ? [...others, name] : others).join(', ') }
  },
})
const dreamingOn = operationSwitch('dreaming')
const termsOn = operationSwitch('retrieval_terms')
function operationList(text = '') { return text.split(',').map(item => item.trim()).filter(Boolean) }
const knownKeys = computed(() => knownKeyReferences(props.payload, savedKeys.value))
const badKeyName = computed(() => {
  const name = draft.value?.secretRef.trim()
  return Boolean(name) && !validKeyReference(name ?? '')
})

function chooseConnection(id: string) {
  if (draft.value) draft.value = withConnection(draft.value, props.payload, id)
}

async function save() {
  if (!props.role || !draft.value || locked.value || badKeyName.value) return
  saving.value = true
  error.value = ''
  try {
    emit('saved', await saveModelRole(props.role, draft.value, props.payload.revision))
  } catch (cause) {
    const code = configConflict(cause)
    if (code) emit('conflict', code)
    else error.value = apiErrorReason(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiDialog :open="Boolean(role && draft)" form size="lg" :busy="saving" :error="shownError"
    :title="t('modelSettings.editTitle', { name })" :description="t('modelSettings.editDescription')"
    data-model-role-dialog @close="emit('close')" @submit="save">
    <div v-if="draft" class="model-role-form">
      <Field orientation="horizontal">
        <Switch id="model-role-enabled" v-model="draft.enabled" :disabled="frozen" />
        <FieldLabel for="model-role-enabled">{{ t('modelSettings.enabled') }}</FieldLabel>
      </Field>
      <p class="model-role-muted" data-model-enabled-hint>{{ enabledHint }}
        <a :href="modelGuideUrl(currentLocale())" target="_blank" rel="noopener noreferrer" data-model-guide>{{ t('modelSettings.guide') }}</a>
      </p>

      <div class="model-role-grid">
        <!-- The three choices name themselves; the group keeps its accessible name. -->
        <UiSegmented v-if="semantic" v-model="preset" class="model-role-wide" :class="{ 'model-role-inactive': inactive }"
          :options="presetOptions" :label="t('modelSettings.semantic.preset')" :inert="inactive || undefined" data-semantic-presets />
        <Field v-if="!semantic">
          <FieldLabel for="model-role-connection">{{ t('modelSettings.connection') }}</FieldLabel>
          <OptionSelect control-id="model-role-connection" :model-value="draft.connectionId" :label="t('modelSettings.connection')" :options="connectionOptions"
            :disabled="inactive" data-model-connection @update:model-value="chooseConnection" />
          <FieldDescription v-if="sharing">{{ t('modelSettings.sharedWith', { names: sharing }) }}</FieldDescription>
        </Field>
        <Field v-if="!semantic">
          <FieldLabel for="model-role-protocol">{{ t('modelSettings.protocol') }}</FieldLabel>
          <OptionSelect control-id="model-role-protocol" v-model="draft.protocol" :label="t('modelSettings.protocol')" :options="protocolOptions" :disabled="inactive" />
        </Field>
        <Field class="model-role-wide">
          <FieldLabel for="model-role-endpoint">{{ t('modelSettings.endpoint') }}</FieldLabel>
          <OptionCombobox control-id="model-role-endpoint" v-model="draft.endpoint" free-text :options="endpointOptions" :label="t('modelSettings.endpoint')"
            placeholder="https://" :disabled="inactive" data-model-endpoint />
        </Field>
        <Field>
          <FieldLabel for="model-role-model">{{ t('modelSettings.model') }}</FieldLabel>
          <OptionCombobox control-id="model-role-model" v-model="draft.model" free-text :options="modelOptions" :label="t('modelSettings.model')"
            :placeholder="t('modelSettings.modelList.placeholder')" :disabled="inactive" data-model-name />
          <!-- One reserved line: what the list holds or why it is empty, and 刷新; nothing around it moves. -->
          <div class="model-role-list" data-model-list-line>
            <GrowthLoading v-if="listed.status === 'loading' && !inactive" variant="inline"
              :label="t('modelSettings.modelList.loading', { host: listed.host })" />
            <span v-else class="model-role-list-text" :title="modelListText" data-model-list-state>{{ modelListText }}</span>
            <Button type="button" variant="link" size="sm" class="model-role-list-refresh" :disabled="inactive || listed.status === 'loading'"
              data-model-list-refresh @click="refreshModels">{{ t('modelSettings.modelList.refresh') }}</Button>
          </div>
        </Field>
        <Field v-if="draft.protocol === 'openai_chat'">
          <FieldLabel for="model-role-effort">{{ t('modelSettings.reasoningEffort') }}</FieldLabel>
          <OptionSelect control-id="model-role-effort" v-model="draft.reasoningEffort" :label="t('modelSettings.reasoningEffort')" :options="effortOptions" :disabled="inactive" />
        </Field>
        <template v-if="!semantic || preset !== 'ollama'">
          <ModelSecretRefField v-model="draft.secretRef" class="model-role-wide" :known="knownKeys" :disabled="inactive" />
          <ModelKeyEntry class="model-role-wide" :reference="draft.secretRef" :endpoint="draft.endpoint" :disabled="inactive" @keys="keys => savedKeys = keys" />
        </template>
      </div>

      <Field v-if="role === 'assistant'" orientation="horizontal">
        <Switch id="model-role-dreaming" v-model="dreamingOn" :disabled="inactive" data-model-dreaming />
        <FieldLabel for="model-role-dreaming">{{ t('modelSettings.dreaming.enable') }}</FieldLabel>
      </Field>
      <Field v-if="role === 'assistant'" orientation="horizontal">
        <Switch id="model-role-terms" v-model="termsOn" :disabled="inactive" data-model-terms />
        <FieldLabel for="model-role-terms">{{ t('modelSettings.retrievalTerms.enable') }}</FieldLabel>
      </Field>

      <fieldset class="model-role-fieldset">
        <legend>{{ t('modelSettings.egressProjectsLabel') }}</legend>
        <p v-if="!projectChoices.length" class="model-role-muted">{{ t('modelSettings.noProjects') }}</p>
        <template v-else>
          <Input v-model="projectQuery" type="search" autocomplete="off" :placeholder="t('modelSettings.projectSearch')" :aria-label="t('modelSettings.projectSearch')"
            data-model-project-search @keydown.enter.prevent />
          <div class="model-role-projects" data-model-projects>
            <div v-for="choice in shownProjects" :key="choice.key" class="model-role-check">
              <Checkbox :id="`model-role-project-${choice.key}`" :model-value="approved.has(choice.key)" :disabled="inactive"
                data-model-egress-project @update:model-value="value => draft = withProject(draft!, choice.project, value === true)" />
              <Label :for="`model-role-project-${choice.key}`" :title="choice.label">{{ choice.label }}</Label>
            </div>
          </div>
          <p v-if="!shownProjects.length" class="model-role-muted">{{ t('modelSettings.projectNoMatch') }}</p>
        </template>
        <div class="model-role-check">
          <Checkbox id="model-role-unassigned" v-model="draft.allowUnassigned" :disabled="inactive" />
          <Label for="model-role-unassigned">{{ t('modelSettings.allowUnassigned') }}</Label>
        </div>
      </fieldset>

      <Accordion v-if="!semantic" type="single" collapsible class="model-role-advanced">
        <AccordionItem value="advanced" data-model-advanced>
          <AccordionTrigger class="model-role-advanced-trigger">{{ t('modelSettings.advanced') }}</AccordionTrigger>
          <AccordionContent class="model-role-advanced-body">
            <Field orientation="horizontal">
              <Checkbox id="model-role-priced" v-model="draft.priced" :disabled="inactive" />
              <FieldLabel for="model-role-priced">{{ t('modelSettings.priced') }}</FieldLabel>
            </Field>
            <div v-if="draft.priced" class="model-role-grid">
              <Field>
                <FieldLabel for="model-role-currency">{{ t('modelSettings.currency') }}</FieldLabel>
                <Input id="model-role-currency" v-model="draft.currency" maxlength="3" autocomplete="off" :disabled="inactive" />
              </Field>
              <Field>
                <FieldLabel for="model-role-input-price">{{ t('modelSettings.inputPrice') }}</FieldLabel>
                <Input id="model-role-input-price" v-model="draft.inputPrice" type="number" min="0" step="any" :disabled="inactive" />
              </Field>
              <Field>
                <FieldLabel for="model-role-output-price">{{ t('modelSettings.outputPrice') }}</FieldLabel>
                <Input id="model-role-output-price" v-model="draft.outputPrice" type="number" min="0" step="any" :disabled="inactive" />
              </Field>
            </div>

            <Field>
              <FieldLabel for="model-role-headers">{{ t('modelSettings.headers') }}</FieldLabel>
              <Textarea id="model-role-headers" v-model="draft.headers" rows="2" spellcheck="false" autocomplete="off" :disabled="frozen" data-model-headers />
              <FieldDescription>{{ t('modelSettings.headersHint') }}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel for="model-role-operations">{{ t('modelSettings.operations') }}</FieldLabel>
              <Input id="model-role-operations" v-model="draft.operations" autocomplete="off" spellcheck="false" :disabled="inactive"
                data-model-operations />
              <FieldDescription>
                {{ t('modelSettings.operationsHint') }}
                {{ wired.length ? t('modelSettings.wired', { operations: wired.join(', ') }) : t('modelSettings.notWired') }}
              </FieldDescription>
            </Field>

            <p class="model-role-muted" data-model-limits-hint>{{ t('modelSettings.limitsHint') }}</p>
            <div class="model-role-grid">
              <Field v-for="field in BUDGET_FIELDS" :key="field">
                <FieldLabel :for="`model-role-${field}`">{{ t(`modelSettings.${field}`) }}</FieldLabel>
                <Input :id="`model-role-${field}`" v-model="draft[field]" type="number" min="1" step="1" :placeholder="t('modelSettings.noLimit')" :disabled="inactive"
                  :data-model-budget="field" />
              </Field>
              <Field>
                <FieldLabel for="model-role-cost-cap">{{ t('modelSettings.maxCostPerWindow') }}</FieldLabel>
                <Input id="model-role-cost-cap" v-model="draft.maxCostPerWindow" type="number" min="0" step="any"
                  :disabled="inactive || !draft.priced" />
                <FieldDescription v-if="!draft.priced">{{ t('modelSettings.costNeedsPrice') }}</FieldDescription>
              </Field>
            </div>

            <Field orientation="horizontal">
              <Switch id="model-role-fallback" v-model="draft.fallbackToSession" :disabled="inactive" />
              <FieldLabel for="model-role-fallback">{{ t('modelSettings.fallback') }}</FieldLabel>
            </Field>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
    <template #footer>
      <Button variant="ghost" :disabled="saving" @click="emit('close')">{{ t('modelSettings.cancel') }}</Button>
      <Button type="submit" :disabled="locked || badKeyName" :loading="saving" :loading-label="t('modelSettings.saving', { name })" data-model-save>
        {{ t('modelSettings.save') }}
      </Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.model-role-form { display: grid; gap: 16px; min-width: 0; }
.model-role-grid { display: grid; align-items: start; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px 16px; }
.model-role-wide { grid-column: 1 / -1; }
.model-role-fieldset { display: grid; gap: 8px; min-width: 0; margin: 0; padding: 0; border: 0; }
.model-role-fieldset legend { margin-bottom: 4px; font-size: 14px; font-weight: 500; }
.model-role-check { display: flex; align-items: center; gap: 10px; min-width: 0; overflow-wrap: anywhere; }
.model-role-projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 8px 16px; max-height: 208px; padding: 2px; overflow-y: auto; }
.model-role-projects label { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-role-advanced :deep(.model-role-advanced-trigger) { padding-block: 8px; font-size: var(--text-body); font-weight: var(--weight-medium); }
.model-role-advanced :deep(.model-role-advanced-body) { display: grid; gap: 16px; padding-top: 8px; }
.model-role-muted { margin: 0; color: var(--color-muted); font-size: 13px; }
.model-role-list { display: flex; align-items: center; gap: 8px; min-width: 0; height: 24px; color: var(--color-muted); font-size: 13px; }
.model-role-list > :first-child { flex: 1 1 auto; min-width: 0; }
.model-role-list-text, .model-role-list :deep(.growth-loading__label) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-role-list :deep(.growth-loading__content) { min-width: 0; }
.model-role-list-refresh { flex: none; min-height: 24px; padding-inline: 0; user-select: none; }
.model-role-inactive { opacity: .5; }
</style>
