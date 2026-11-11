<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import { UiDialog, UiIcon } from '@/ui'
import { ORGANIZE_SENTENCE, readProjectOrganizing, runCounts, type ProjectOrganizingState } from './project-organizing'

// 整理 on a project page (rec issue 114): how well FULI knows the project in one
// line, and one action that copies the sentence the person says to their own
// AI. The nine areas and the earlier runs open in 「查看详情」, so the card
// keeps one height. Nothing here starts a model: Astro organises in the
// person's own client, with that session's model.
const props = defineProps<{ spaceId: string; projectId: string }>()

const state = ref<ProjectOrganizingState | null>(null)
const failed = ref(false)
const details = ref(false)
const copied = ref(false)
const copyFailed = ref(false)
let reading: AbortController | null = null
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const lastRun = computed(() => state.value?.runs[0] ?? null)
const headline = computed(() => (state.value?.started
  ? t('projects.organizing.progress', { settled: state.value.progress.settled, total: state.value.progress.total })
  : t('projects.organizing.never')))
const line = computed(() => (lastRun.value
  ? t('projects.organizing.lastRun', { date: formatDateTime(lastRun.value.at, currentLocale(), DATE_ONLY, { missing: '' }), counts: runCounts(lastRun.value) })
  : t('projects.organizing.hint')))
const areaName = (area: { zh: string; en: string }) => (currentLocale() === 'zh-CN' ? area.zh : area.en)
const tone = (status: string) => (status === 'known' ? 'success' : status === 'unsure' ? 'warning' : 'secondary')

async function read() {
  reading?.abort()
  reading = new AbortController()
  try {
    state.value = await readProjectOrganizing(props.spaceId, props.projectId, reading.signal)
    failed.value = false
  } catch (cause) {
    if ((cause as Error)?.name !== 'AbortError') failed.value = true
  }
}

async function copy() {
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(ORGANIZE_SENTENCE)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 4000)
  } catch {
    copyFailed.value = true
  }
}

watch(() => [props.spaceId, props.projectId], () => { state.value = null; void read() }, { immediate: true })
onBeforeUnmount(() => { reading?.abort(); clearTimeout(copiedTimer) })
</script>

<template>
  <section class="project-organizing" :data-project-organizing="projectId">
    <div class="project-organizing-main">
      <p class="project-organizing-head">
        <strong>{{ t('projects.organizing.title') }}</strong>
        <span class="project-organizing-progress" data-organizing-progress>{{ failed ? t('projects.organizing.unavailable') : headline }}</span>
      </p>
      <p class="project-organizing-line" :title="line" data-organizing-line>
        {{ copyFailed ? t('projects.organizing.copyFailed', { sentence: ORGANIZE_SENTENCE }) : copied ? t('projects.organizing.copiedHint') : line }}
      </p>
    </div>
    <div class="project-organizing-actions">
      <Button v-if="state?.started" size="sm" variant="ghost" data-organizing-details @click="details = true">{{ t('projects.organizing.details') }}</Button>
      <Button size="sm" variant="outline" class="project-organizing-copy" :title="ORGANIZE_SENTENCE" data-organizing-copy @click="copy">
        <UiIcon name="ai" :size="14" class="project-organizing-mark" />{{ copied ? t('projects.organizing.copied') : t('projects.organizing.copy') }}
      </Button>
    </div>
    <UiDialog :open="details" :title="t('projects.organizing.detailsTitle')" :description="headline" size="md" data-organizing-dialog @close="details = false">
      <ul v-if="state" class="project-organizing-areas">
        <li v-for="area in state.areas" :key="area.id" class="project-organizing-area" :data-organizing-area="area.id">
          <span class="project-organizing-area-name" :title="area.note ?? areaName(area)">{{ areaName(area) }}</span>
          <Badge :variant="tone(area.status)">{{ t(`projects.organizing.statuses.${area.status}`) }}</Badge>
        </li>
      </ul>
      <ul v-if="state?.runs.length" class="project-organizing-runs" data-organizing-runs>
        <li v-for="run in state.runs" :key="run.at" class="project-organizing-run">
          <span>{{ formatDateTime(run.at, currentLocale(), DATE_ONLY, { missing: '' }) }}</span>
          <span class="project-organizing-run-counts" :title="runCounts(run)">{{ runCounts(run) }}</span>
          <span v-if="run.model" class="project-organizing-run-model" :title="run.model">{{ run.model }} · {{ t(`projects.organizing.tiers.${run.tier}`) }}</span>
        </li>
      </ul>
    </UiDialog>
  </section>
</template>

<style scoped>
.project-organizing { display: flex; align-items: center; gap: 12px; min-width: 0; }
.project-organizing-main { display: grid; flex: 1 1 auto; gap: 4px; min-width: 0; }
.project-organizing-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; margin: 0; }
.project-organizing-head strong { font-size: 14px; font-weight: 550; }
.project-organizing-progress { color: var(--color-ink-soft); font-size: 13px; }
/* One line, always: the card keeps its height whatever it says. */
.project-organizing-line { margin: 0; overflow: hidden; color: var(--color-muted); font-size: 12px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.project-organizing-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.project-organizing-actions :deep(button) { user-select: none; }
.project-organizing-mark { margin-inline-end: 6px; color: var(--color-ai); fill: currentColor; stroke-width: 1; }
.project-organizing-areas, .project-organizing-runs { display: grid; margin: 0; padding: 0; list-style: none; font-size: var(--text-control); }
.project-organizing-area, .project-organizing-run { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; min-height: 32px; }
.project-organizing-area + .project-organizing-area, .project-organizing-run + .project-organizing-run { border-top: 1px solid var(--color-border); }
.project-organizing-area-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-organizing-runs { margin-top: var(--space-4); color: var(--color-muted); }
.project-organizing-run-counts { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--color-ink-soft); text-overflow: ellipsis; white-space: nowrap; }
.project-organizing-run-model { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
