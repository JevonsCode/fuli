<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { readProjectHistoryEvidence, type CountEvidence } from './evidence-reader'
import { buildHistoryPreview, type HistoryPreview, type ProjectPreview } from './preview-model'

const props = defineProps<{ spaceId: string }>()

const preview = ref<HistoryPreview | null>(null)
const loading = ref(false)
const failed = ref(false)
const progress = ref<{ done: number, total: number } | null>(null)
let controller: AbortController | null = null

const loadingLabel = computed(() => progress.value
  ? t('projectHistory.loadingEvidence', {
      done: Math.min(progress.value.done + 1, progress.value.total), total: progress.value.total,
    })
  : t('projectHistory.loadingProjects'))
const names = computed(() => new Map((preview.value?.projects ?? [])
  .map(({ evidence }) => [evidence.project.project_id, evidence.project.profile.name])))

watch(() => props.spaceId, () => {
  controller?.abort()
  preview.value = null
  failed.value = false
})
onBeforeUnmount(() => controller?.abort())

async function generate() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  failed.value = false
  progress.value = null
  try {
    const { projects } = await readProjectHistoryEvidence(props.spaceId, {
      signal: current.signal,
      onProgress: (done, total) => { if (controller === current) progress.value = { done, total } },
    })
    if (controller === current) preview.value = buildHistoryPreview(projects)
  } catch {
    if (controller === current && !current.signal.aborted) failed.value = true
  } finally {
    if (controller === current) {
      loading.value = false
      progress.value = null
    }
  }
}

function countLabel(value: CountEvidence) {
  const text = t(`projectHistory.status.${value.status}`, { count: value.count })
  return value.reason ? `${text} · ${t(`projectHistory.reason.${value.reason}`)}` : text
}

function relationLabel(item: ProjectPreview) {
  const { knowledge } = item.evidence
  if (knowledge.status === 'failed') return t('projectHistory.status.failed')
  const value = `${knowledge.relations} / ${knowledge.referencedElsewhere}`
  return knowledge.status === 'complete' ? value : t('projectHistory.status.incomplete', { count: value })
}

function mergeLabel(item: ProjectPreview) {
  const list = new Intl.ListFormat(currentLocale(), { type: 'conjunction' })
    .format(item.mergeWith.map(id => names.value.get(id) ?? id))
  return t('projectHistory.mergeWith', { projects: list })
}
</script>

<template>
  <section class="project-history" aria-labelledby="project-history-heading">
    <header class="project-history-header">
      <div>
        <h3 id="project-history-heading">{{ t('projectHistory.title') }}</h3>
        <p class="project-history-hint">{{ t('projectHistory.hint') }}</p>
      </div>
      <GrowthLoading v-if="loading" variant="inline" :label="loadingLabel" />
      <Button size="sm" variant="ghost" v-else data-generate @click="generate">
        {{ preview ? t('projectHistory.regenerate') : t('projectHistory.generate') }}
      </Button>
    </header>

    <div v-if="failed" class="project-history-state" role="alert">
      <p>{{ t('projectHistory.failed') }}</p>
    </div>

    <template v-if="preview">
      <p v-if="!preview.projects.length" class="project-history-hint">{{ t('projectHistory.empty') }}</p>
      <template v-else>
        <p v-if="preview.complete" class="project-history-summary" data-completeness="complete">
          {{ t('projectHistory.complete', { count: preview.projects.length }) }}
        </p>
        <p v-else class="project-history-summary is-incomplete" data-completeness="incomplete" role="status">
          {{ t('projectHistory.incomplete', { incomplete: preview.incompleteCount, count: preview.projects.length }) }}
        </p>
        <p class="project-history-hint" data-memory-unknown>{{ t('projectHistory.memoryUnknown') }}</p>
        <div class="project-history-table-wrap">
          <table class="project-history-table">
            <thead>
              <tr>
                <th scope="col">{{ t('projectHistory.columns.project') }}</th>
                <th scope="col">{{ t('projectHistory.columns.origin') }}</th>
                <th scope="col">{{ t('projectHistory.columns.knowledge') }}</th>
                <th scope="col">{{ t('projectHistory.columns.tasks') }}</th>
                <th scope="col">{{ t('projectHistory.columns.assignments') }}</th>
                <th scope="col">{{ t('projectHistory.columns.relations') }}</th>
                <th scope="col">{{ t('projectHistory.columns.suggestion') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in preview.projects"
                :key="item.evidence.project.project_id"
                :data-project="item.evidence.project.project_id"
                :data-suggestion="item.suggestion"
              >
                <th scope="row">
                  <span>{{ item.evidence.project.profile.name }}</span>
                  <small>{{ item.evidence.project.project_id }}</small>
                  <small v-if="item.sameNameCount" :title="t('projectHistory.sameNameNote')">
                    {{ t('projectHistory.sameName', { count: item.sameNameCount }) }} · {{ t('projectHistory.sameNameNote') }}
                  </small>
                </th>
                <td>{{ t(`projectHistory.origin.${item.origin}`) }}</td>
                <td>{{ countLabel(item.evidence.knowledge) }}</td>
                <td>{{ countLabel(item.evidence.tasks) }}</td>
                <td>{{ countLabel(item.evidence.assignments) }}</td>
                <td>{{ relationLabel(item) }}</td>
                <td>
                  <span>{{ t(`projectHistory.suggestion.${item.suggestion}`) }}</span>
                  <small v-if="item.mergeWith.length">{{ mergeLabel(item) }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.project-history { display: grid; gap: 12px; margin-top: 24px; padding: 16px; border: 1px solid var(--color-border); border-radius: 12px; }
.project-history-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.project-history-header h3 { margin: 0; }
.project-history-hint, .project-history-summary { margin: 4px 0 0; color: var(--color-muted); line-height: 1.6; }
.project-history-summary.is-incomplete { color: var(--color-warning, var(--color-text)); font-weight: 600; }
.project-history-state { color: var(--color-danger, var(--color-text)); }
.project-history-table-wrap { overflow-x: auto; }
.project-history-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.project-history-table th, .project-history-table td { padding: 8px; border-top: 1px solid var(--color-border); text-align: left; vertical-align: top; }
.project-history-table small { display: block; color: var(--color-muted); overflow-wrap: anywhere; }
</style>
