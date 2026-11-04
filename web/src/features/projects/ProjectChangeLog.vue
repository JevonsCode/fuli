<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { UiNotice } from '@/ui'
import ProjectChangeActor from './ProjectChangeActor.vue'
import {
  changedFieldLabel,
  changedFieldNames,
  changedValueText,
  readProjectChanges,
  type ProjectChangeEntry,
} from './project-change-log'

// 修改记录 on the project overview: the latest changes, full before and after
// text in 「查看详情」. Read when the overview opens and again after a save
// (updatedAt moves). No history shows nothing; a failed read says so instead.
const VISIBLE_CHANGES = 5

const props = defineProps<{ spaceId: string; projectId: string; projectName: string; updatedAt?: string | null }>()

const entries = ref<ProjectChangeEntry[] | null>(null)
const hasMore = ref(false)
const loading = ref(false)
const failed = ref(false)
const detailsOpen = ref(false)
let sequence = 0

const known = computed(() => entries.value ?? [])
const latest = computed(() => known.value.slice(0, VISIBLE_CHANGES))
// A retry keeps the failure line and its pending button instead of a second indicator.
const showInitialLoading = useMinimumLoadingDisplay(computed(() => loading.value && !entries.value && !failed.value))
const showRefreshing = useMinimumLoadingDisplay(computed(() => loading.value && known.value.length > 0 && !failed.value))
const visible = computed(() => showInitialLoading.value || failed.value || known.value.length > 0)
const time = (value: string) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '-' })

watch(() => props.updatedAt, load, { immediate: true })

async function load() {
  const current = ++sequence
  loading.value = true
  try {
    const history = await readProjectChanges(props.spaceId, props.projectId)
    if (current !== sequence) return
    entries.value = history.entries
    hasMore.value = history.hasMore
    failed.value = false
  } catch {
    if (current === sequence) failed.value = true
  } finally {
    if (current === sequence) loading.value = false
  }
}
</script>

<template>
  <Card v-if="visible" as="section" aria-labelledby="project-change-log-title" data-project-change-log>
    <CardHeader>
      <CardTitle id="project-change-log-title">{{ t('projects.overview.changeLog.title') }}</CardTitle>
      <CardAction v-if="known.length" class="project-change-log-actions">
        <GrowthLoading v-if="showRefreshing" variant="inline" :label="t('projects.overview.changeLog.refreshing')" />
        <Button type="button" size="sm" variant="ghost" aria-haspopup="dialog" data-project-change-details-open
          @click="detailsOpen = true">
          {{ t('common.actions.viewDetails') }}
        </Button>
      </CardAction>
    </CardHeader>

    <div class="project-change-log-body">
      <GrowthLoading v-if="showInitialLoading" variant="compact" :label="t('projects.overview.changeLog.loading')" />
      <UiNotice v-if="failed" :tone="known.length ? 'warning' : 'error'" data-project-change-log-failed>
        {{ t(known.length ? 'projects.overview.changeLog.refreshFailed' : 'projects.overview.changeLog.failed') }}
        <template #actions>
          <Button type="button" size="sm" variant="ghost" :loading="loading"
            :loading-label="t('projects.overview.changeLog.loading')" @click="load">
            {{ t('common.actions.retry') }}
          </Button>
        </template>
      </UiNotice>
      <ul v-if="latest.length" class="project-change-list">
        <li v-for="entry in latest" :key="entry.id" class="project-change-row" :data-project-change="entry.id">
          <span class="project-change-summary">
            <ProjectChangeActor :space-id="spaceId" :actor="entry.actor" />
            {{ t('projects.overview.changeLog.changed', { fields: changedFieldNames(entry) }) }}
          </span>
          <time class="ui-meta project-change-time" :datetime="entry.at">{{ time(entry.at) }}</time>
        </li>
      </ul>
    </div>

    <Dialog v-model:open="detailsOpen">
      <DialogContent size="lg" data-project-change-details>
        <DialogHeader>
          <DialogTitle>{{ t('projects.overview.changeLog.title') }}</DialogTitle>
          <DialogDescription>{{ projectName }}</DialogDescription>
        </DialogHeader>
        <ol class="project-change-details">
          <li v-for="entry in known" :key="entry.id" class="project-change-detail">
            <p class="ui-meta">
              <ProjectChangeActor :space-id="spaceId" :actor="entry.actor" /> · <time :datetime="entry.at">{{ time(entry.at) }}</time>
            </p>
            <section v-for="change in entry.changes" :key="change.field" class="project-change-field" :data-changed-field="change.field">
              <h4 class="ui-group-label">{{ changedFieldLabel(change.field) }}</h4>
              <dl class="project-change-values">
                <dt>{{ t('projects.overview.changeLog.before') }}</dt>
                <dd>{{ changedValueText(change.field, change.before) }}</dd>
                <dt>{{ t('projects.overview.changeLog.after') }}</dt>
                <dd>{{ changedValueText(change.field, change.after) }}</dd>
              </dl>
            </section>
          </li>
        </ol>
        <p v-if="hasMore" class="ui-meta" data-project-change-more>
          {{ t('projects.overview.changeLog.latestOnly', { count: known.length }) }}
        </p>
      </DialogContent>
    </Dialog>
  </Card>
</template>

<style scoped>
.project-change-log-actions { display: flex; align-items: center; gap: var(--space-2); }
.project-change-log-body { display: grid; gap: var(--space-3); padding-inline: var(--space-5); }
.project-change-list, .project-change-details { display: grid; margin: 0; padding: 0; list-style: none; }
.project-change-list { gap: var(--space-2); }
.project-change-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px var(--space-4); }
.project-change-summary { min-width: 0; font-size: var(--text-body); overflow-wrap: anywhere; }
.project-change-time { flex: none; font-variant-numeric: tabular-nums; }
.project-change-details { gap: var(--space-5); }
.project-change-detail { display: grid; gap: var(--space-3); min-width: 0; }
.project-change-field { display: grid; gap: var(--space-1); }
.project-change-values { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px var(--space-3); margin: 0; font-size: var(--text-body); }
.project-change-values dt { color: var(--color-muted); font-size: var(--text-meta); line-height: 1.7; }
.project-change-values dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
