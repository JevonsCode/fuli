<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
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
  <main class="shared-jefa-report">
    <header><strong>Jefa</strong><h1>{{ t('employees.share.title') }}</h1><span>{{ t('employees.share.readOnly') }}</span></header>
    <GrowthLoading v-if="loading" :label="t('employees.loadingReport')" />
    <div v-else-if="error" class="report-state" role="alert"><p>{{ error }}</p><button type="button" @click="load">{{ t('employees.retry') }}</button></div>
    <template v-else>
      <p v-if="failed" class="report-warning">{{ t('employees.share.unavailableCount', { count: failed }) }}</p>
      <div v-if="!publicTaskCount" class="report-state" role="status"><h2>{{ t('employees.shareContent.emptyTitle') }}</h2><p>{{ t('employees.shareContent.emptyReport', { count: boards.length }) }}</p><button type="button" @click="load">{{ t('common.actions.refresh') }}</button></div>
      <EmployeeTaskBoard v-else v-model:visible-project-ids="visible" :boards="boards.filter(board => visible.includes(board.project.id))" :projects="boards.map(board => board.project)" :failed-projects="0" :can-move-tasks="false" read-only @retry="load" />
    </template>
  </main>
</template>

<style scoped>
.shared-jefa-report { height: 100dvh; display: flex; flex-direction: column; min-height: 0; background: #fff; overflow: hidden; }
.shared-jefa-report > header { display: flex; align-items: center; gap: 16px; padding: 20px 24px; border-bottom: 1px solid #e2e9e4; }
header strong { color: #315c43; font-size: 22px; }
header h1 { margin: 0; font-size: 18px; }
header span { margin-left: auto; font-size: 12px; color: #526659; }
.report-state { margin: auto; padding: 24px; text-align: center; }
.report-state h2 { font-size: 18px; }
.report-state p { max-width: 44ch; color: #526659; line-height: 1.7; }
.report-state button { min-height: 44px; padding: 8px 16px; border: 1px solid #bdcbbf; border-radius: 8px; background: #fff; color: #315c43; }
.report-warning { margin: 12px 24px 0; font-size: 13px; color: #8d5a31; }
</style>
