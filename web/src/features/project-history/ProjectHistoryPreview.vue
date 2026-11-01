<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { readProjectHistoryEvidence, type CountEvidence } from './evidence-reader'
import { buildHistoryPreview, type HistoryPreview, type ProjectPreview } from './preview-model'

const props = defineProps<{ spaceId: string }>()

// The bar under the projects starts a read-only preview; the result opens in a
// centred dialog, so the projects keep the page and the table gets the width.
const open = ref(false)
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
  open.value = false
  preview.value = null
  failed.value = false
})
// Closing stops a read in progress; the last finished preview stays for the next opening.
function openChange(value: boolean) {
  open.value = value
  if (!value && loading.value) {
    controller?.abort()
    loading.value = false
    progress.value = null
  }
}
function start() {
  open.value = true
  void generate()
}
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
  <!-- A quiet toolbar button (Jevons 11-01): the preview is a rare tool, never a bar pinned under the page. -->
  <span class="project-history">
    <Button variant="ghost" class="shrink-0" data-generate aria-haspopup="dialog" :title="t('projectHistory.title')" @click="start">
      {{ preview ? t('projectHistory.regenerate') : t('projectHistory.generate') }}
    </Button>

    <Dialog :open="open" @update:open="openChange">
      <DialogContent class="max-w-[min(1120px,calc(100%-32px))]" data-project-history-dialog>
        <DialogHeader>
          <DialogTitle>{{ t('projectHistory.title') }}</DialogTitle>
          <DialogDescription>{{ t('projectHistory.hint') }}</DialogDescription>
        </DialogHeader>

        <GrowthLoading v-if="loading" variant="compact" :label="loadingLabel" />
        <div v-else-if="failed" class="project-history-state" role="alert">
          <p class="m-0">{{ t('projectHistory.failed') }}</p>
        </div>

        <template v-if="preview && !loading">
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

        <DialogFooter v-if="!loading && (preview || failed)" class="flex justify-end border-t pt-4">
          <Button size="sm" variant="outline" data-regenerate @click="generate">{{ t('projectHistory.regenerate') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </span>
</template>

<style scoped>
/* A slim bar under the projects, on the page gutter and clear of the dock; the preview itself is a dialog. */
.project-history { display: inline-flex; }
.project-history-hint, .project-history-summary { margin: 2px 0 0; color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.project-history-summary.is-incomplete { color: var(--color-warning); font-weight: 600; }
.project-history-state { color: var(--color-danger); }
.project-history-table-wrap { overflow-x: auto; }
.project-history-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.project-history-table th, .project-history-table td { padding: 8px; border-top: 1px solid var(--color-border); text-align: left; vertical-align: top; }
.project-history-table small { display: block; color: var(--color-muted); overflow-wrap: anywhere; }
</style>
