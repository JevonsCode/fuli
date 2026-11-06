<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import { CARD_CONTENT_FIELDS, CARD_TIME_FIELDS, type CardField } from './task-card-fields'

// 卡片显示: which fields a board card shows. It stays open while the person
// ticks several, and the cards change behind it as they do. Loaded
// asynchronously by EmployeeTaskBoard, like the card's move menu.
defineProps<{ fields: ReadonlySet<CardField>; isDefault: boolean }>()
const emit = defineEmits<{ toggle: [field: CardField]; reset: [] }>()
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon" :aria-label="t('employees.card.menu')" :title="t('employees.card.menu')" data-card-fields>
        <UiIcon name="list" :size="18" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-44">
      <DropdownMenuLabel>{{ t('employees.card.groups.content') }}</DropdownMenuLabel>
      <DropdownMenuCheckboxItem v-for="field in CARD_CONTENT_FIELDS" :key="field" :model-value="fields.has(field)" :data-card-field="field"
        @select.prevent @update:model-value="emit('toggle', field)">{{ t(`employees.card.fields.${field}`) }}</DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{{ t('employees.card.groups.time') }}</DropdownMenuLabel>
      <DropdownMenuCheckboxItem v-for="field in CARD_TIME_FIELDS" :key="field" :model-value="fields.has(field)" :data-card-field="field"
        @select.prevent @update:model-value="emit('toggle', field)">{{ t(`employees.card.fields.${field}`) }}</DropdownMenuCheckboxItem>
      <template v-if="!isDefault">
        <DropdownMenuSeparator />
        <DropdownMenuItem data-card-fields-reset @select.prevent="emit('reset')">{{ t('employees.card.reset') }}</DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
