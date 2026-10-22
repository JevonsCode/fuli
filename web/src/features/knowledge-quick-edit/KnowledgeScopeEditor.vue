<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { getJson } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import UiSelect from '@/ui/UiSelect.vue'
import {
  editFailure, initialScopeDraft, isPreference, scopeChoices, scopeRequest,
  type EditFailure, type KnowledgeItemSummary, type ScopeChoice,
} from './model'
import { saveScope } from './quick-edit-api'

// Where one item applies from now on: a preference to personal global, one or
// more projects, or one FLA; other knowledge to one or more projects (rec#20
// part 2). The same item moves; nothing is copied, and the history keeps
// where it applied before.
const props = defineProps<{ item: KnowledgeItemSummary; spaceId: string; projects: PersonalProject[] }>()
const emit = defineEmits<{ saved: []; failed: [reason: EditFailure] }>()

const draft = ref(initialScopeDraft(props.item))
const reason = ref('')
const saving = ref(false)
const agents = ref<Array<{ value: string; label: string }>>([])
const message = ref<{ kind: 'error' | 'status' | 'widening'; text: string } | null>(null)
watch(() => props.item.version, () => { draft.value = initialScopeDraft(props.item) })

const projectOptions = computed(() => props.projects.filter(project => project.scope_type !== 'temporary')
  .map(project => ({ value: project.project_id, label: project.profile.name || project.project_id })))
const choices = computed(() => scopeChoices(props.item))
const request = computed(() => scopeRequest(props.spaceId, props.item, draft.value, reason.value))

const choiceLabel = (choice: ScopeChoice) => t(`knowledgeQuickEdit.scope.option${choice === 'global' ? 'Global'
  : choice === 'projects' ? 'Projects' : 'Agent'}`)

watch(() => draft.value.agentProjectId, async project => {
  agents.value = []
  if (!project || draft.value.choice !== 'agent') return
  try {
    const value = await getJson<unknown>(`/api/project-agents?${new URLSearchParams({ personalSpaceId: props.spaceId,
      personalProjectId: project, status: 'active' })}`)
    const list = Array.isArray(value) ? value : (value as { agents?: unknown[] })?.agents ?? []
    agents.value = (list as Array<{ agentId?: string; profile?: { name?: string } }>)
      .filter(agent => agent.agentId).map(agent => ({ value: agent.agentId!, label: agent.profile?.name || agent.agentId! }))
  } catch {
    agents.value = []
  }
}, { immediate: true })
watch(() => draft.value.choice, choice => { if (choice === 'agent' && !draft.value.agentProjectId) {
  draft.value.agentProjectId = draft.value.projectIds[0] ?? projectOptions.value[0]?.value ?? '' } })

async function save() {
  if (!request.value) return
  saving.value = true
  message.value = null
  try {
    await saveScope(props.item, request.value)
    reason.value = ''
    message.value = { kind: 'status', text: t('knowledgeQuickEdit.scope.saved') }
    emit('saved')
  } catch (error) {
    const failure = editFailure(error)
    message.value = failure === 'widening' ? { kind: 'widening', text: t('knowledgeQuickEdit.scope.widening') }
      : { kind: 'error', text: failure === 'forbidden' ? t('knowledgeQuickEdit.forbidden')
        : failure === 'conflict' ? t('knowledgeQuickEdit.conflict')
          : failure === 'project_match' ? t('knowledgeQuickEdit.scope.projectMatch') : String((error as Error).message) }
    emit('failed', failure)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Card as="section" data-scope-editor>
    <CardHeader>
      <CardTitle as="h2">{{ t('knowledgeQuickEdit.scope.title') }}</CardTitle>
      <CardDescription>{{ t('knowledgeQuickEdit.scope.narrowing') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5" @submit.prevent="save">
      <Field v-if="choices.length > 1">
        <FieldLabel id="scope-choice-label">{{ t('knowledgeQuickEdit.scope.choose') }}</FieldLabel>
        <RadioGroup v-model="draft.choice" aria-labelledby="scope-choice-label" class="grid gap-2" :disabled="saving">
          <label v-for="choice in choices" :key="choice" class="flex items-center gap-2 text-sm" :data-scope-choice="choice">
            <RadioGroupItem :value="choice" />{{ choiceLabel(choice) }}
          </label>
        </RadioGroup>
      </Field>
      <UiSelect v-if="draft.choice === 'projects'" v-model="draft.projectIds" field multiple
        :label="t('knowledgeQuickEdit.scope.projectsField')" :options="projectOptions" :disabled="saving" data-scope-projects />
      <p v-if="!isPreference(item)" class="m-0 text-xs text-muted-foreground" data-scope-other-knowledge>
        {{ t('knowledgeQuickEdit.scope.otherKnowledge') }}
      </p>
      <template v-if="draft.choice === 'agent'">
        <UiSelect v-model="draft.agentProjectId" field :label="t('knowledgeQuickEdit.scope.project')"
          :options="projectOptions" :disabled="saving" data-scope-agent-project />
        <UiSelect v-if="agents.length" v-model="draft.agentId" field :label="t('knowledgeQuickEdit.scope.agentLabel')"
          :options="agents" :disabled="saving" data-scope-agent />
        <p v-else class="m-0 text-xs text-muted-foreground">{{ t('knowledgeQuickEdit.scope.noAgents') }}</p>
      </template>
      <Field>
        <FieldLabel for="scope-reason">{{ t('knowledgeQuickEdit.scope.reason') }}</FieldLabel>
        <Input id="scope-reason" v-model="reason" :disabled="saving" maxlength="2000" autocomplete="off" />
        <FieldDescription v-if="!reason.trim()">{{ t('knowledgeQuickEdit.reasonRequired') }}</FieldDescription>
      </Field>
      <p v-if="message" :role="message.kind === 'status' ? 'status' : 'alert'" class="m-0 text-sm"
        :class="message.kind === 'status' ? 'text-success' : 'text-destructive'" data-scope-message>
        {{ message.text }}
        <RouterLink v-if="message.kind === 'widening'" to="/preferences" class="underline">
          {{ t('knowledgeQuickEdit.scope.openReview') }}
        </RouterLink>
      </p>
      <div>
        <Button type="submit" :disabled="!request" :loading="saving" :loading-label="t('knowledgeQuickEdit.scope.saving')">
          {{ t('knowledgeQuickEdit.scope.save') }}
        </Button>
      </div>
    </form>
  </Card>
</template>
