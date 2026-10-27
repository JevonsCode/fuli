<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import EmployeeTaskBoard, { type EmployeeProjectBoard } from '@/features/employees/EmployeeTaskBoard.vue'
import { publicProjectReport, reportProjects } from '@/features/employees/shared-report'
const route = useRoute()
const boards = ref<EmployeeProjectBoard[]>([])
const visible = ref<string[]>([])
const loading = ref(false)
const failed = ref(0)
const error = ref('')
const publicTaskCount = computed(() => boards.value.reduce((total, board) => total + board.items.length, 0))
// Vue Router decodes route.hash, including escaped ampersands inside project IDs.
// fullPath preserves the original fragment so URLSearchParams can decode it once.
const encodedHash = computed(() => route.fullPath.includes('#') ? route.fullPath.slice(route.fullPath.indexOf('#')) : route.hash)
let version = 0
watch(encodedHash, () => { void load() }, { immediate: true })
async function load() {
  const current = ++version
  boards.value = []; error.value = ''; failed.value = 0; loading.value = true
  try {
    const scope = reportProjects(encodedHash.value)
    const results = await Promise.allSettled(scope.map(publicProjectReport))
    if (current !== version) return
    boards.value = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    visible.value = boards.value.map(board => board.project.id)
    failed.value = results.filter(result => result.status === 'rejected').length
    if (!boards.value.length) error.value = t('employees.share.unavailable')
  } catch { if (current === version) error.value = t('employees.share.unavailable') }
  finally { if (current === version) loading.value = false }
}
</script>

<template>
  <!-- A shared link opens outside the console shell, so this page renders its own one H1. -->
  <main class="shared-jefa-report">
    <header class="shared-jefa-report-bar">
      <div class="mx-auto flex w-full max-w-(--canvas-max) flex-wrap items-baseline gap-x-4 gap-y-1">
        <strong class="text-xl">Jefa</strong>
        <h1 class="m-0 text-lg font-semibold">{{ t('employees.share.title') }}</h1>
        <span class="ml-auto text-xs text-muted-foreground">{{ t('employees.share.readOnly') }}</span>
      </div>
    </header>
    <div class="shared-jefa-report-canvas mx-auto flex min-h-0 w-full flex-1 flex-col">
      <GrowthLoading v-if="loading" :label="t('employees.loadingReport')" />
      <Card v-else-if="error" class="report-state" role="alert">
        <p>{{ error }}</p>
        <Button variant="outline" @click="load">{{ t('employees.retry') }}</Button>
      </Card>
      <template v-else>
        <UiNotice v-if="failed" tone="warning" class="report-warning">{{ t('employees.share.unavailableCount', { count: failed }) }}</UiNotice>
        <Card v-if="!publicTaskCount" class="report-state" role="status">
          <h2 class="m-0 text-lg font-semibold">{{ t('employees.shareContent.emptyTitle') }}</h2>
          <p>{{ t('employees.shareContent.emptyReport', { count: boards.length }) }}</p>
          <Button variant="outline" @click="load">{{ t('common.actions.refresh') }}</Button>
        </Card>
        <EmployeeTaskBoard v-else v-model:visible-project-ids="visible" :boards="boards.filter(board => visible.includes(board.project.id))" :projects="boards.map(board => board.project)" :failed-projects="0" :can-move-tasks="false" read-only @retry="load" />
      </template>
    </div>
  </main>
</template>

<style scoped>
/* The report is a board (a full work area): one canvas, centred on wide screens.
   The board keeps its own 24px inset, so the bar uses the same one and the
   canvas is that much wider: the title and the board start on one line. */
.shared-jefa-report { height: 100dvh; display: flex; flex-direction: column; min-height: 0; background: var(--color-surface); color: var(--color-ink); overflow: hidden; }
.shared-jefa-report-bar { flex: 0 0 auto; padding: 16px 24px; border-bottom: 1px solid var(--color-border); }
.shared-jefa-report-canvas { max-width: calc(var(--canvas-max) + 48px); }
.report-state { align-items: center; max-width: 520px; margin: 48px auto; padding: 32px 24px; text-align: center; }
.report-state p { max-width: 44ch; margin: 0; color: var(--color-muted); line-height: 1.7; }
.report-warning { margin: 12px 24px 0; }
</style>
