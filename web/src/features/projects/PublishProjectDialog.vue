<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
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
  if (busy.value) return
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
  <UiDialog v-if="project" open class="publish-dialog" :title="t('projects.publishDialog.title')"
    :description="t('projects.publishDialog.warning')" :busy="busy" :error="error" @close="emit('close')">
    <p class="publish-dialog-project">{{ project.profile.name }}</p>
    <label class="ui-field">{{ t('projects.publishDialog.version') }}
      <input v-model="version" maxlength="64" :placeholder="t('projects.publishDialog.versionPlaceholder')" />
      <small class="ui-field-hint">{{ currentVersion ? t('projects.publishDialog.currentVersion', { version: currentVersion }) : t('projects.publishDialog.firstRelease') }}</small>
    </label>
    <label class="ui-field">{{ t('projects.publishDialog.summary') }}
      <textarea v-model="summary" maxlength="4096" rows="4" :placeholder="t('projects.publishDialog.summaryPlaceholder')" />
    </label>
    <dl class="publish-impact" :aria-label="t('projects.publishDialog.impactAria')">
      <div><dt>{{ t('projects.publishDialog.discoverable') }}</dt><dd>{{ t('projects.publishDialog.discoverableCopy') }}</dd></div>
      <div><dt>{{ t('projects.publishDialog.owner') }}</dt><dd>{{ t('projects.publishDialog.ownerCopy') }}</dd></div>
      <div><dt>{{ t('projects.publishDialog.syncProfile') }}</dt><dd>{{ t('projects.publishDialog.syncProfileCopy') }}</dd></div>
    </dl>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" :busy="busy" :busy-label="t('projects.publishDialog.publishing')" @click="publish">{{ t('projects.publishDialog.confirm') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.publish-dialog-project { margin: 0; font-size: 15px; font-weight: 600; }
.publish-impact { margin: 0; border-block: 1px solid var(--color-border); }
.publish-impact > div { display: grid; grid-template-columns: 108px 1fr; gap: 14px; padding: 10px 0; font-size: 12px; }
.publish-impact > div + div { border-top: 1px solid var(--color-border); }
.publish-impact dt { font-weight: 600; }
.publish-impact dd { margin: 0; color: var(--color-muted); line-height: 1.5; }
</style>
