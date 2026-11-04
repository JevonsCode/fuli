<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { boardItemKey, recentBoardItems, type EmployeeBoardItem, type EmployeeProjectBoard } from './task-board-model'

// What last changed on Jefa's board: each task's latest update, newest first.
const SHOWN = 5
const props = defineProps<{ boards: EmployeeProjectBoard[] }>()
const emit = defineEmits<{ select: [item: EmployeeBoardItem] }>()
const all = ref(false)
const items = computed(() => recentBoardItems(props.boards))
const rows = computed(() => all.value ? items.value : items.value.slice(0, SHOWN))
const projectName = (id: string) => props.boards.find(board => board.project.id === id)?.project.name ?? id
const time = (value?: string) => formatDateTime(value, currentLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: '' })
</script>

<template>
  <Card v-if="items.length" as="section" class="board-activity" aria-labelledby="board-activity-title" data-board-activity>
    <h2 id="board-activity-title">{{ t('employees.allProjects.recent') }}</h2>
    <ul>
      <li v-for="item in rows" :key="boardItemKey(item)">
        <button type="button" class="board-activity-row" data-board-activity-row @click="emit('select', item)">
          <time :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
          <span class="board-activity-status" :class="`is-${item.status}`">{{ t(`employees.allProjects.status.${item.status}`) }}</span>
          <span class="board-activity-title">{{ item.title }}<small v-if="item.summary"> — {{ item.summary }}</small></span>
          <span class="board-activity-project">{{ projectName(item.projectId) }}</span>
        </button>
      </li>
    </ul>
    <Button v-if="items.length > SHOWN" variant="ghost" size="sm" class="board-activity-more" data-board-activity-all @click="all = !all">
      {{ t(all ? 'employees.allProjects.recentLess' : 'employees.allProjects.recentAll') }}
    </Button>
  </Card>
</template>

<style scoped>
.board-activity { display: grid; flex: 0 0 auto; gap: 8px; padding: 14px 18px; }
.board-activity h2 { margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); }
.board-activity ul { display: grid; margin: 0; padding: 0; list-style: none; }
.board-activity-row {
  display: grid; grid-template-columns: 96px auto minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; min-height: 36px; padding: 4px 8px;
  border: 0; border-radius: var(--radius-control); color: var(--color-ink); background: none; font: inherit; font-size: 13px; text-align: left; cursor: pointer; user-select: none;
}
.board-activity-row:hover { background: var(--color-surface-subtle); }
.board-activity-row:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.board-activity-row time { color: var(--color-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.board-activity-status { padding: 1px 8px; border-radius: var(--radius-pill); color: var(--color-ink-soft); background: var(--color-surface-subtle); font-size: 12px; white-space: nowrap; }
.board-activity-status.is-done { color: var(--color-success); background: var(--color-success-soft); }
.board-activity-status.is-blocked { color: var(--color-danger); background: var(--color-danger-soft); }
.board-activity-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-activity-title small { color: var(--color-muted); font-size: 12px; }
.board-activity-project { color: var(--color-muted); font-size: 12px; white-space: nowrap; }
.board-activity-more { justify-self: start; }
@media (max-width: 700px) {
  .board-activity-row { grid-template-columns: auto minmax(0, 1fr); }
  .board-activity-row time, .board-activity-project { display: none; }
}
</style>
