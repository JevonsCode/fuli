<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { z } from 'zod'
import { ApiError, getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { useClipboardCopy } from '@/composables/useClipboardCopy'
import { currentLocale, t } from '@/i18n'
import { usePageRefresh } from '@/layouts/page-refresh'
import { UiIcon, UiNotice } from '@/ui'
import { FULI_VERSION } from '@/version'

const shape = shapeOf(z.object({ markdown: z.string().min(1) }))
const snapshot = ref('')
const failure = ref('')
const accessDenied = ref(false)
const loading = ref(false)
const manualCopy = ref(false)
const preview = useTemplateRef<InstanceType<typeof Textarea>>('preview')
const { copied, failed, copy } = useClipboardCopy()
let request: AbortController | null = null

const report = computed(() => {
  if (!failure.value) return snapshot.value
  if (!snapshot.value) return failure.value
  return [failure.value, '', `### ${t('debugTurns.issue.previous')}`, '', snapshot.value].join('\n')
})

async function load() {
  request?.abort()
  const reading = new AbortController()
  request = reading
  loading.value = true
  manualCopy.value = false
  // The host can return recorded events while its configuration scan continues.
  const signal = AbortSignal.any([reading.signal, AbortSignal.timeout(12_000)])
  try {
    const result = await getJson(`/api/diagnostics/issue-report?locale=${currentLocale()}`, shape, { signal })
    if (reading.signal.aborted) return
    snapshot.value = result.markdown
    failure.value = ''
    accessDenied.value = false
  } catch (error) {
    if (reading.signal.aborted) return
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      snapshot.value = ''
      failure.value = ''
      accessDenied.value = true
      return
    }
    if (accessDenied.value) return
    const code = error instanceof ApiError
      ? error.status >= 400 ? `HTTP ${error.status}` : 'diagnostics_invalid_response'
      : signal.aborted ? 'diagnostics_timeout' : 'diagnostics_unreachable'
    // Only the version, clock and a fixed failure code leave the client.
    failure.value = [`## ${t('debugTurns.issue.title')}`, `FULI UI ${FULI_VERSION} | ${new Date().toISOString()}`,
      `GET /api/diagnostics/issue-report | ${code}`].join('\n')
  } finally {
    if (request === reading) loading.value = false
  }
}

async function copyReport() {
  await copy(report.value, report.value)
  manualCopy.value = failed.value
  if (manualCopy.value) {
    const field = preview.value?.$el as HTMLTextAreaElement | undefined
    field?.focus()
    field?.select()
  }
}

watch(currentLocale, load, { immediate: true })
usePageRefresh(load)
onBeforeUnmount(() => request?.abort())
</script>

<template>
  <Card as="section" data-issue-log :aria-label="t('debugTurns.issue.title')">
    <CardHeader>
      <CardTitle as="h2">{{ t('debugTurns.issue.title') }}</CardTitle>
      <CardDescription>{{ t('debugTurns.issue.hint') }}</CardDescription>
    </CardHeader>
    <div class="issue-log-body">
      <GrowthLoading v-if="loading && !report && !accessDenied" variant="compact" :label="t('debugTurns.issue.loading')" />
      <UiNotice v-if="accessDenied" tone="warning" data-issue-denied>{{ t('debugTurns.issue.hostOnly') }}</UiNotice>
      <template v-if="report">
        <UiNotice v-if="failure" tone="warning">{{ t('debugTurns.issue.unavailable') }}</UiNotice>
        <Textarea ref="preview" class="issue-log-preview" readonly spellcheck="false" :model-value="report"
          :aria-label="t('debugTurns.issue.preview')" />
      </template>
      <div v-if="report || accessDenied" class="issue-log-actions">
        <Button v-if="report" size="sm" data-issue-copy @click="copyReport">
          <UiIcon :name="copied === report ? 'check' : 'copy'" :size="15" />
          {{ copied === report ? t('debugTurns.issue.copied') : t('debugTurns.issue.copy') }}
        </Button>
        <Button variant="outline" size="sm" data-issue-refresh :disabled="loading" @click="load">
          <GrowthLoading v-if="loading" variant="inline" :label="t('debugTurns.issue.loading')" />
          <template v-else>{{ t('debugTurns.issue.refresh') }}</template>
        </Button>
        <span class="sr-only" role="status">{{ report && copied === report ? t('debugTurns.issue.copied') : '' }}</span>
        <UiNotice v-if="manualCopy" tone="warning">{{ t('debugTurns.issue.manual') }}</UiNotice>
      </div>
    </div>
  </Card>
</template>

<style scoped>
.issue-log-body { display: grid; gap: 12px; padding-inline: 20px; }
.issue-log-preview { field-sizing: fixed; height: 11rem; resize: vertical; font-family: var(--font-mono, monospace); font-size: var(--text-meta); }
.issue-log-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>
