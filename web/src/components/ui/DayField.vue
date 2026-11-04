<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date'
import {
  CalendarCell, CalendarCellTrigger, CalendarGrid, CalendarGridBody, CalendarGridHead, CalendarGridRow, CalendarHeadCell,
  CalendarHeader, CalendarHeading, CalendarNext, CalendarPrev, CalendarRoot,
} from 'reka-ui'
import { Button } from '@/components/ui/button'
import { FIELD_LOOK } from '@/components/ui/field-look'
import { currentLocale, t } from '@/i18n'
import { cn } from '@/lib/class-names'
import { UiIcon, UiIconButton } from '@/ui'

// A calendar day as YYYY-MM-DD ('' for none). The month opens under the field,
// inside the form, so it works in a modal dialog, whose top layer covers
// anything rendered outside it.
const day = defineModel<string>({ default: '' })
const props = defineProps<{ label: string; disabled?: boolean }>()
const open = ref(false)
const root = ref<HTMLElement>()
// A form that scrolls brings the month into view as it opens.
async function toggle() {
  open.value = !open.value
  if (!open.value) return
  await nextTick()
  root.value?.scrollIntoView({ block: 'nearest' })
}
const value = computed(() => (day.value ? parseDate(day.value) : undefined))
const shown = computed(() => (value.value
  ? new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(value.value.toDate(getLocalTimeZone())) : t('common.dayField.none')))
function pick(next: DateValue | undefined) {
  day.value = next ? next.toString() : ''
  open.value = false
}
</script>

<template>
  <div ref="root" class="ui-field day-field" data-day-field>
    <span>{{ props.label }}</span>
    <div class="day-field-row">
      <Button variant="ghost" :class="cn(FIELD_LOOK, 'day-field-trigger')" :disabled="disabled" :aria-expanded="open" :aria-label="`${props.label}: ${shown}`" data-day-field-trigger @click="toggle">
        <span :class="{ 'day-field-empty': !day }">{{ shown }}</span>
        <UiIcon name="chevron-down" :size="16" />
      </Button>
      <UiIconButton v-if="day && !disabled" icon="close" size="md" :label="t('common.dayField.clear')" data-day-field-clear @click="pick(undefined)" />
    </div>
    <CalendarRoot v-if="open" v-slot="{ weekDays, grid }" class="day-field-calendar" :model-value="value" :locale="currentLocale()" :default-placeholder="value ?? today(getLocalTimeZone())"
      fixed-weeks weekday-format="narrow" @update:model-value="pick($event as DateValue | undefined)">
      <CalendarHeader class="day-field-head">
        <CalendarPrev class="day-field-step" :aria-label="t('common.dayField.previous')"><UiIcon name="chevron-left" :size="16" /></CalendarPrev>
        <CalendarHeading class="day-field-month" />
        <CalendarNext class="day-field-step" :aria-label="t('common.dayField.next')"><UiIcon name="chevron-right" :size="16" /></CalendarNext>
      </CalendarHeader>
      <CalendarGrid v-for="month in grid" :key="month.value.toString()" class="day-field-grid">
        <CalendarGridHead>
          <CalendarGridRow class="day-field-week">
            <CalendarHeadCell v-for="name in weekDays" :key="name" class="day-field-weekday">{{ name }}</CalendarHeadCell>
          </CalendarGridRow>
        </CalendarGridHead>
        <CalendarGridBody>
          <CalendarGridRow v-for="(week, index) in month.rows" :key="index" class="day-field-week">
            <CalendarCell v-for="date in week" :key="date.toString()" :date="date">
              <CalendarCellTrigger :day="date" :month="month.value" class="day-field-day" />
            </CalendarCell>
          </CalendarGridRow>
        </CalendarGridBody>
      </CalendarGrid>
    </CalendarRoot>
  </div>
</template>

<style scoped>
.day-field { display: grid; gap: 6px; }
.day-field-row { display: flex; align-items: center; gap: 6px; }
.day-field-trigger { flex: 1; justify-content: space-between; min-width: 0; font-weight: var(--weight-regular); }
.day-field-trigger:hover, .day-field-trigger[aria-expanded="true"] { background: var(--color-surface); }
.day-field-empty { color: var(--color-muted); }
.day-field-calendar { display: grid; gap: 6px; width: min(100%, 280px); padding: 8px; border: 1px solid var(--color-border); border-radius: var(--radius-control); background: var(--color-surface); }
.day-field-head { display: flex; align-items: center; justify-content: space-between; }
.day-field-month { font-size: var(--text-control); font-weight: var(--weight-medium); }
.day-field-step { appearance: none; display: grid; width: 28px; height: 28px; padding: 0; place-items: center; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--color-muted); cursor: pointer; }
.day-field-step:hover { background: var(--color-surface-hover); color: var(--color-ink); }
.day-field-grid { width: 100%; border-collapse: collapse; }
.day-field-week { display: grid; grid-template-columns: repeat(7, 1fr); }
.day-field-weekday { color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular); text-align: center; }
.day-field-day { display: grid; height: 32px; place-items: center; border-radius: var(--radius-control); font-size: var(--text-control); font-weight: var(--weight-regular); font-variant-numeric: tabular-nums; cursor: pointer; }
.day-field-day:hover { background: var(--color-surface-hover); }
.day-field-day[data-outside-view] { color: var(--color-faint); }
.day-field-day[data-today] { box-shadow: inset 0 0 0 1px var(--color-border-strong); }
.day-field-day[data-selected] { background: var(--color-accent); color: var(--color-on-accent); }
</style>
