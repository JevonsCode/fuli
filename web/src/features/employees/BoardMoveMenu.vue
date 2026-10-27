<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import { isColumnMove, type BoardColumn } from './project-board-layout'
import { boardItemKey, type EmployeeBoardItem } from './task-board-model'

// A card's "Move to…" menu: the non-drag way to move a task. It only offers
// columns the shared move rule allows; the board submits the choice. Loaded
// asynchronously by EmployeeTaskBoard, so pages that cannot move tasks never
// load the menu.
defineProps<{ item: EmployeeBoardItem; columns: readonly BoardColumn[]; current: string; disabled: boolean }>()
const emit = defineEmits<{ move: [column: string]; 'close-auto-focus': [event: Event] }>()
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child :disabled="disabled">
      <Button
        variant="ghost"
        size="icon-sm"
        data-move-control="menu"
        :disabled="disabled"
        :aria-label="t('employees.allProjects.moveTo', { task: item.title })"
        :title="t('employees.allProjects.moveTo', { task: item.title })"
      >
        <UiIcon name="more" :size="16" />
      </Button>
    </DropdownMenuTrigger>
    <!-- The portal names its card, so the board knows whose focus this is. -->
    <DropdownMenuContent align="end" :data-move-menu-for="boardItemKey(item)" @close-auto-focus="emit('close-auto-focus', $event)">
      <DropdownMenuLabel>{{ t('employees.allProjects.moveToLabel') }}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        v-for="column in columns"
        :key="column.key"
        :disabled="!isColumnMove(columns, item, column.key)"
        :data-move-target="column.key"
        @select="emit('move', column.key)"
      >
        {{ column.key === current ? t('employees.allProjects.currentStatus', { status: column.label }) : column.label }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
