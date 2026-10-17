<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { ApiError } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import { createPersonalProject, newProjectId, type NewProjectDraft } from './project-create'

const props = defineProps<{ open: boolean; personalSpaceId: string; existingProjectIds: string[]; initialPurpose?: string }>()
const emit = defineEmits<{ close: []; created: [project: PersonalProject] }>()

const empty = (): NewProjectDraft => ({ name: '', purpose: props.initialPurpose ?? '', includes: '', excludes: '', source: '' })
const draft = ref<NewProjectDraft>(empty())
const busy = ref(false)
const error = ref('')
const projectId = computed(() => newProjectId(draft.value.name, props.existingProjectIds))

watch(() => props.open, (open) => {
  if (open) { draft.value = empty(); error.value = '' }
}, { immediate: true })

async function create() {
  if (busy.value) return
  if (!draft.value.name.trim()) {
    error.value = t('projects.createDialog.nameRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    emit('created', await createPersonalProject(props.personalSpaceId, projectId.value, draft.value))
  } catch (cause) {
    error.value = cause instanceof ApiError && cause.status === 409
      ? t('projects.createDialog.exists')
      : (cause instanceof Error && cause.message) || t('projects.createDialog.failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiDialog v-if="open" open class="create-project-dialog" size="lg" form :busy="busy" :error="error"
    :title="t('projects.createDialog.title')" :description="t('projects.createDialog.intro')"
    @close="emit('close')" @submit="create">
    <div class="create-project-fields">
      <label class="ui-field">{{ t('projects.createDialog.name') }}
        <input v-model="draft.name" name="new-project-name" maxlength="160" required autofocus />
        <small v-if="draft.name.trim()" class="ui-field-hint" data-new-project-id>{{ t('projects.createDialog.identifier', { id: projectId }) }}</small>
      </label>
      <label class="ui-field">{{ t('projects.createDialog.purpose') }}
        <textarea v-model="draft.purpose" name="new-project-purpose" maxlength="4096" rows="2" :placeholder="t('projects.createDialog.purposePlaceholder')" />
      </label>
      <label class="ui-field">{{ t('projects.createDialog.includes') }}
        <textarea v-model="draft.includes" name="new-project-includes" maxlength="4096" rows="3" :placeholder="t('projects.createDialog.includesPlaceholder')" />
      </label>
      <label class="ui-field">{{ t('projects.createDialog.excludes') }}
        <textarea v-model="draft.excludes" name="new-project-excludes" maxlength="8192" rows="3" :placeholder="t('projects.createDialog.excludesPlaceholder')" />
      </label>
      <label class="ui-field">{{ t('projects.createDialog.source') }}
        <input v-model="draft.source" name="new-project-source" maxlength="2048" :placeholder="t('projects.createDialog.sourcePlaceholder')" />
      </label>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" :busy="busy" :busy-label="t('projects.createDialog.creating')">{{ t('projects.createDialog.create') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.create-project-fields { display: grid; gap: 14px; }
</style>
