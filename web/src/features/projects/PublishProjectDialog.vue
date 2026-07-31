<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { PersonalProject } from '@/types'

const props = defineProps<{
  project: PersonalProject | null
}>()

const emit = defineEmits<{
  close: []
  published: []
}>()

const store = useConsoleStore()
const version = ref('')
const summary = ref('')
const error = ref('')
const busy = ref(false)

const publicProject = computed(() =>
  store.state?.projects.find(
    ({ publication_key }) => publication_key && publication_key === props.project?.publication_key,
  ) ?? null,
)
const currentVersion = computed(() => publicProject.value?.current_release?.version ?? null)
const providerUrl = computed(
  () => store.state?.providers?.workspaces?.find(({ status }) => status === 'ready')?.providerUrl ?? null,
)

watch(
  () => props.project,
  (project) => {
    if (!project) return
    version.value = suggestedVersion(currentVersion.value)
    summary.value = ''
    error.value = ''
  },
  { immediate: true },
)

async function publish() {
  if (!props.project) return
  if (!providerUrl.value) {
    error.value = t('projects.publishDialog.errors.providerUnavailable')
    return
  }
  if (!version.value.trim()) {
    error.value = t('projects.publishDialog.errors.versionRequired')
    return
  }
  if (!summary.value.trim()) {
    error.value = t('projects.publishDialog.errors.summaryRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    await postJson('/api/projects/publish', {
      personalSpaceId: store.activePersonalSpace?.id,
      localProjectId: props.project.project_id,
      providerUrl: providerUrl.value,
      releaseVersion: version.value.trim(),
      updateSummary: summary.value.trim(),
    })
    store.notify(t('projects.publishDialog.published', {
      name: props.project.profile.name,
      version: version.value.trim(),
    }))
    await store.refresh()
    emit('close')
    emit('published')
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : t('projects.publishDialog.errors.failed')
    store.reportError(cause)
  } finally {
    busy.value = false
  }
}

function suggestedVersion(current: string | null) {
  if (!current || current === 'legacy') return 'v1.0.0'
  const match = current.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return ''
  return `${match[1]}${match[2]}.${match[3]}.${Number(match[4]) + 1}`
}
</script>

<template>
  <dialog v-if="project" open class="publish-dialog vue-dialog">
    <div class="publish-dialog-shell">
      <p class="eyebrow">PUBLICATION</p>
      <h3>{{ t('projects.publishDialog.title') }}</h3>
      <p class="publish-dialog-intro">
        <strong>{{ project.profile.name }}</strong>
        <span>{{ t('projects.publishDialog.warning') }}</span>
      </p>
      <div class="publish-release-fields">
        <label><span>{{ t('projects.publishDialog.version') }}</span><input v-model="version" maxlength="64" :placeholder="t('projects.publishDialog.versionPlaceholder')" /><small>{{ currentVersion ? t('projects.publishDialog.currentVersion', { version: currentVersion }) : t('projects.publishDialog.firstRelease') }}</small></label>
        <label><span>{{ t('projects.publishDialog.summary') }}</span><textarea v-model="summary" maxlength="4096" rows="4" :placeholder="t('projects.publishDialog.summaryPlaceholder')" /></label>
      </div>
      <div class="publish-impact" :aria-label="t('projects.publishDialog.impactAria')">
        <div><strong>{{ t('projects.publishDialog.discoverable') }}</strong><span>{{ t('projects.publishDialog.discoverableCopy') }}</span></div>
        <div><strong>{{ t('projects.publishDialog.owner') }}</strong><span>{{ t('projects.publishDialog.ownerCopy') }}</span></div>
        <div><strong>{{ t('projects.publishDialog.syncProfile') }}</strong><span>{{ t('projects.publishDialog.syncProfileCopy') }}</span></div>
      </div>
      <p v-if="error" class="publish-dialog-error" role="alert">{{ error }}</p>
      <div class="publish-dialog-actions">
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</button>
        <button class="primary-action" type="button" :disabled="busy" @click="publish">{{ busy ? t('projects.publishDialog.publishing') : t('projects.publishDialog.confirm') }}</button>
      </div>
    </div>
  </dialog>
</template>
