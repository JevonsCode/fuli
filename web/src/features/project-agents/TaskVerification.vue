<script setup lang="ts">
import { ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { evidenceLine, readTaskVerification, stateLabel, type Verification } from '@/features/verification/verification'

// A finished task's acceptance state (rec#78), read once the details open:
// tests a verifier passed, Tonborg's acceptance, the person. A server that
// cannot say shows nothing rather than a guess.
const props = defineProps<{ personalSpaceId: string, personalProjectId: string, taskId: string, active: boolean }>()
const value = ref<Verification | null>(null)
const loading = ref(false)
let read = false
watch(() => props.active, async (active) => {
  if (!active || read) return
  read = true
  loading.value = true
  try { value.value = await readTaskVerification(props.personalSpaceId, props.personalProjectId, props.taskId) }
  catch { value.value = null }
  finally { loading.value = false }
}, { immediate: true })
</script>

<template>
  <GrowthLoading v-if="loading" variant="inline" :label="t('verification.loading')" />
  <p v-else-if="value" class="task-verification" data-task-verification :data-state="value.state">
    <span class="task-verification-label">{{ t('verification.title') }}</span>
    <strong>{{ stateLabel(value) }}</strong>
    <span v-if="value.evidence.length" class="project-agent-muted">{{ evidenceLine(value) }}</span>
  </p>
</template>

<style scoped>
.task-verification { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); margin: 0; font-size: var(--text-body); }
.task-verification-label { color: var(--muted-foreground); font-size: var(--text-meta); }
.task-verification strong { font-weight: var(--weight-medium); }
.task-verification[data-state='unverified'] strong { color: var(--muted-foreground); }
</style>
