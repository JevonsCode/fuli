<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { Switch } from '@/components/ui/switch'
import { failedSaveMessage, projectOffSinceDay, projectRecorded } from './project-capture'

// "记忆这个项目" on a project page (rec#5 C4-1): the switch moves at once, the
// save shows inline, the settings page reads the same saved settings, and a
// failed save says what is known about it. The page renders one instance per
// project (keyed by its ID), so a request for one project never shows on another.
const props = defineProps<{ projectId: string; projectName: string }>()

const store = useConsoleStore()
const policy = computed(() => store.state?.capturePolicy)
const requested = ref<boolean | null>(null)
const failure = ref('')
const recorded = computed(() => requested.value ?? projectRecorded(policy.value, props.projectId))
const offSince = computed(() => projectOffSinceDay(policy.value, props.projectId))
const captureOff = computed(() => policy.value?.enabled === false)
const state = computed(() => recorded.value ? t('capture.project.on')
  : offSince.value && requested.value === null ? t('capture.project.offSince', { day: offSince.value })
    : t('capture.project.off'))

// The page may have loaded before an Agent changed the settings (C4-4); until
// the fresh read arrives the switch shows the last saved state.
onMounted(() => { store.loadCapturePolicy().catch(() => {}) })

async function setRecorded(value: boolean) {
  if (requested.value !== null) return
  requested.value = value
  failure.value = ''
  try {
    await store.changeCapturePolicy({ recordProjects: { [props.projectId]: value } })
  } catch (error) {
    failure.value = await failedSaveMessage(error, () => store.settledCapturePolicy())
  } finally {
    requested.value = null
  }
}
</script>

<template>
  <section class="project-capture-switch" :data-project-capture="projectId" :data-recorded="recorded">
    <label class="project-capture-row">
      <strong>{{ t('capture.project.label') }}</strong>
      <Switch :model-value="recorded" :aria-label="t('capture.project.label')" :disabled="requested !== null"
        @update:model-value="setRecorded" />
    </label>
    <GrowthLoading v-if="requested !== null" variant="inline" data-project-capture-pending
      :label="t(requested ? 'capture.project.turningOn' : 'capture.project.turningOff', { name: projectName })" />
    <p v-else-if="failure" class="project-capture-failure" role="alert" data-project-capture-error>{{ failure }}</p>
    <p v-else class="project-capture-state">{{ state }}</p>
    <p v-if="captureOff" class="project-capture-state" data-project-capture-global-off>{{ t('capture.project.globalOff') }}</p>
  </section>
</template>

<style scoped>
.project-capture-switch { display: grid; gap: 4px; min-width: 0; }
.project-capture-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; }
.project-capture-row strong { font-size: 14px; font-weight: 550; }
.project-capture-state, .project-capture-failure { margin: 0; font-size: 12px; line-height: 1.5; color: var(--color-muted); }
.project-capture-failure { color: var(--color-danger); }
</style>
