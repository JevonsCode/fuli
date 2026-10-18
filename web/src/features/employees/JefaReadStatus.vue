<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiButton from '@/ui/UiButton.vue'
import { RouterLink } from 'vue-router'
import { t, currentLocale } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import type { JefaReadFailure, JefaReadStage } from './useJefaBoardLoad'

defineProps<{
  loading: boolean; longWait: boolean; stage: JefaReadStage; timedOut: boolean
  failure: string; failures: JefaReadFailure[]; total: number; loaded: number; pending: number
  hasContent: boolean; stale: boolean; updatedAt: string
}>()
defineEmits<{ reload: [] }>()
</script>

<template>
  <div v-if="loading || timedOut || failure || failures.length || stale" class="jefa-read-status" :class="{ 'is-blocking': !hasContent }" :role="!loading && (timedOut || failure || failures.length) ? 'alert' : undefined">
    <GrowthLoading v-if="loading" :variant="hasContent ? 'compact' : 'page'" :label="t(hasContent && stale ? 'employees.read.updating' : `employees.read.${stage}`)" />
    <div v-if="!loading && (timedOut || failure || failures.length)" class="jefa-read-error">
      <h2>{{ t(hasContent ? 'employees.read.partialTitle' : timedOut ? 'employees.read.timeoutTitle' : 'employees.read.failedTitle') }}</h2>
      <p v-if="failure">{{ failure }}</p>
      <p>{{ t(stale ? 'employees.read.previous' : 'employees.read.unchanged') }}</p>
    </div>
    <p v-if="total && (loading || failures.length)" role="status">{{ t('employees.read.counts', { loaded, total, pending, failed: failures.filter(f => f.projectId).length }) }}</p>
    <p v-if="loading && longWait" class="jefa-read-long" role="status">{{ t('employees.read.long') }}</p>
    <p v-if="stale">{{ t('employees.read.readOnly') }} <span v-if="updatedAt">{{ t('employees.read.lastRead', { time: formatDateTime(updatedAt, currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }, { missing: '—' }) }) }}</span></p>
    <div v-if="!loading" class="jefa-read-actions">
      <UiButton variant="primary" @click="$emit('reload')">{{ t('employees.read.reload') }}</UiButton>
      <RouterLink to="/project-agents" class="ui-button">{{ t('employees.backToAgents') }}</RouterLink>
      <span v-if="hasContent">{{ t('employees.read.reloadHint') }}</span>
    </div>
    <details v-if="!loading && failures.length" class="jefa-read-details">
      <summary>{{ t('employees.read.details') }}</summary>
      <p v-for="(item, index) in failures" :key="index">{{ t(`employees.read.${item.stage}`) }} · {{ item.category }} · {{ formatDateTime(item.at, currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }, { missing: '—' }) }}</p>
    </details>
  </div>
</template>

<style scoped>
.jefa-read-status { flex: 0 0 auto; display: grid; gap: 12px; padding: 16px 24px; color: var(--color-muted); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.jefa-read-status.is-blocking { flex: 1; place-content: center; justify-items: start; align-self: center; width: min(100%, 660px); overflow: auto; }
.jefa-read-status p, .jefa-read-status h2 { margin: 0; }
.jefa-read-status h2 { color: var(--color-ink); font-size: 20px; line-height: 1.4; margin-bottom: 8px; }
.jefa-read-error { display: grid; gap: 4px; }
.jefa-read-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.jefa-read-actions .ui-button { min-height: 44px; text-decoration: none; }
.jefa-read-details summary { cursor: pointer; color: var(--color-ink); padding-block: 6px; }
.jefa-read-details summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
.jefa-read-details p { margin-top: 8px; }
@media (max-width: 640px) { .jefa-read-status { padding: 16px; }.jefa-read-actions span { flex-basis: 100%; } }
</style>
