<script setup lang="ts">
import { computed, ref } from 'vue'

import { t } from '@/i18n'

export type EmployeeBoardStatus = 'planned' | 'active' | 'blocked' | 'review' | 'done'

export interface EmployeeBoardItem {
  id: string
  projectId: string
  title: string
  summary?: string
  status: EmployeeBoardStatus
  priority?: 'critical' | 'high' | 'medium' | 'low'
  tags?: string[]
}

export interface EmployeeProjectBoard {
  project: { id: string; name: string }
  items: EmployeeBoardItem[]
  total: number
  truncated: boolean
}

const props = defineProps<{
  boards: EmployeeProjectBoard[]
  totalProjects: number
  failedProjects: number
}>()

const emit = defineEmits<{
  'select-project': [projectId: string]
  retry: []
}>()

const query = ref('')
const statusDefinitions: ReadonlyArray<{ value: EmployeeBoardStatus; labelKey: string }> = [
  { value: 'planned', labelKey: 'employees.allProjects.status.planned' },
  { value: 'active', labelKey: 'employees.allProjects.status.active' },
  { value: 'blocked', labelKey: 'employees.allProjects.status.blocked' },
  { value: 'review', labelKey: 'employees.allProjects.status.review' },
  { value: 'done', labelKey: 'employees.allProjects.status.done' },
]
const projectNames = computed(() => new Map(props.boards.map(({ project }) => [project.id, project.name])))
const allItems = computed(() => props.boards.flatMap(({ items }) => items))
const filteredItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return allItems.value
  return allItems.value.filter((item) => [
    item.title,
    item.summary,
    projectNames.value.get(item.projectId),
    ...(item.tags ?? []),
  ].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
})
const columns = computed(() => statusDefinitions.map((definition) => ({
  ...definition,
  items: filteredItems.value.filter(({ status }) => status === definition.value),
})))
const truncatedProjects = computed(() => props.boards.filter(({ truncated }) => truncated).length)
const hasItems = computed(() => allItems.value.length > 0)
const hasMatches = computed(() => filteredItems.value.length > 0)

function projectName(projectId: string) {
  return projectNames.value.get(projectId) ?? projectId
}
</script>

<template>
  <section class="employee-all-projects" aria-labelledby="employee-all-projects-title">
    <header class="employee-all-projects-header">
      <div class="employee-all-projects-heading">
        <h2 id="employee-all-projects-title">{{ t('employees.allProjects.title') }}</h2>
        <p>{{ t('employees.allProjects.hint', { count: boards.length }) }}</p>
      </div>
      <label class="employee-all-projects-search">
        <span>{{ t('employees.allProjects.search') }}</span>
        <input v-model="query" type="search" :placeholder="t('employees.allProjects.searchPlaceholder')" />
      </label>
    </header>

    <div v-if="failedProjects" class="employee-all-projects-notice" role="status">
      <span>{{ t('employees.allProjects.partial', { loaded: boards.length, total: totalProjects, failed: failedProjects }) }}</span>
      <button type="button" @click="emit('retry')">{{ t('employees.retry') }}</button>
    </div>
    <div v-if="truncatedProjects" class="employee-all-projects-notice" role="status">
      {{ t('employees.allProjects.truncated', { count: truncatedProjects }) }}
    </div>

    <div v-if="!hasItems" class="employee-all-projects-empty">
      <h3>{{ t('employees.allProjects.empty') }}</h3>
      <p>{{ t('employees.allProjects.emptyHint') }}</p>
    </div>
    <div v-else-if="!hasMatches" class="employee-all-projects-empty">
      <h3>{{ t('employees.allProjects.noMatch') }}</h3>
      <p>{{ t('employees.allProjects.noMatchHint') }}</p>
    </div>
    <div v-else class="employee-all-projects-board" :aria-label="t('employees.allProjects.boardLabel')">
      <section v-for="column in columns" :key="column.value" class="employee-all-projects-column">
        <header>
          <h3>{{ t(column.labelKey) }}</h3>
          <span :aria-label="t('employees.allProjects.taskCount', { count: column.items.length })">{{ column.items.length }}</span>
        </header>
        <div class="employee-all-projects-list">
          <button
            v-for="item in column.items"
            :key="`${item.projectId}:${item.id}`"
            type="button"
            class="employee-all-projects-task"
            :aria-label="t('employees.allProjects.openTask', { project: projectName(item.projectId), task: item.title })"
            @click="emit('select-project', item.projectId)"
          >
            <span class="employee-all-projects-project">{{ projectName(item.projectId) }}</span>
            <strong>{{ item.title }}</strong>
            <span v-if="item.summary && item.summary !== item.title" class="employee-all-projects-summary">{{ item.summary }}</span>
            <span v-if="item.tags?.length" class="employee-all-projects-tags" aria-hidden="true">
              <span v-for="tag in item.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
            </span>
          </button>
          <p v-if="!column.items.length" class="employee-all-projects-column-empty">{{ t('employees.allProjects.columnEmpty') }}</p>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.employee-all-projects { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; gap: 14px; padding: 14px 24px 24px; overflow: hidden; background: #f7f8f7; color: #253c2f; }
.employee-all-projects-header { display: flex; flex: 0 0 auto; align-items: end; justify-content: space-between; gap: 24px; }
.employee-all-projects-heading { min-width: 0; }
.employee-all-projects-heading h2 { margin: 0 0 4px; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
.employee-all-projects-heading p { margin: 0; color: #5b6b61; font-size: 13px; line-height: 1.5; }
.employee-all-projects-search { display: grid; flex: 0 1 300px; gap: 5px; color: #516158; font-size: 12px; }
.employee-all-projects-search input { width: 100%; min-height: 40px; border: 1px solid #cbd5ce; border-radius: 9px; background: #fff; color: #253c2f; font: inherit; font-size: 14px; padding: 8px 11px; }
.employee-all-projects-search input:focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
.employee-all-projects-notice { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; padding: 8px 12px; border-radius: 10px; background: #f2ead8; color: #654d21; font-size: 13px; }
.employee-all-projects-notice button { border: 0; background: transparent; color: inherit; font: inherit; font-weight: 650; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.employee-all-projects-notice button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.employee-all-projects-board { display: grid; flex: 1; grid-template-columns: repeat(5, minmax(230px, 1fr)); gap: 12px; min-height: 0; overflow-x: auto; padding-bottom: 4px; }
.employee-all-projects-column { display: flex; min-width: 230px; min-height: 0; flex-direction: column; overflow: hidden; border-radius: 14px; background: #ecefed; }
.employee-all-projects-column > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 10px; padding: 13px 14px 10px; }
.employee-all-projects-column h3 { margin: 0; font-size: 14px; font-weight: 650; }
.employee-all-projects-column > header span { display: grid; min-width: 24px; height: 24px; place-items: center; border-radius: 12px; background: #dce3de; color: #425349; font-size: 12px; font-variant-numeric: tabular-nums; }
.employee-all-projects-list { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; overflow-y: auto; padding: 0 8px 10px; }
.employee-all-projects-task { display: flex; width: 100%; flex: 0 0 auto; flex-direction: column; align-items: stretch; gap: 7px; padding: 11px 12px; border: 0; border-radius: 12px; background: #fff; color: #253c2f; font: inherit; text-align: left; cursor: pointer; box-shadow: 0 2px 8px rgb(37 60 47 / 7%); }
.employee-all-projects-task:hover { background: #fbfdfb; box-shadow: 0 4px 13px rgb(37 60 47 / 11%); }
.employee-all-projects-task:focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
.employee-all-projects-task strong { display: -webkit-box; overflow: hidden; font-size: 13px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.employee-all-projects-project { overflow: hidden; color: #4a6755; font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.employee-all-projects-summary { display: -webkit-box; overflow: hidden; color: #65736a; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.employee-all-projects-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.employee-all-projects-tags span { max-width: 100%; overflow: hidden; border-radius: 5px; background: #edf3ef; color: #52665a; font-size: 10px; line-height: 1.5; padding: 2px 6px; text-overflow: ellipsis; white-space: nowrap; }
.employee-all-projects-column-empty { margin: 24px 8px; color: #728078; font-size: 12px; text-align: center; }
.employee-all-projects-empty { display: grid; flex: 1; place-content: center; justify-items: center; padding: 30px; text-align: center; }
.employee-all-projects-empty h3 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.employee-all-projects-empty p { max-width: 46ch; margin: 0; color: #64736a; font-size: 13px; line-height: 1.6; }
@media (max-width: 760px) {
  .employee-all-projects { padding: 10px 16px 18px; }
  .employee-all-projects-header { align-items: stretch; flex-direction: column; gap: 10px; }
  .employee-all-projects-search { flex-basis: auto; }
  .employee-all-projects-board { grid-template-columns: repeat(5, minmax(82vw, 1fr)); }
}
</style>
