import { computed, ref } from 'vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { formatRelativeTime } from '@/lib/relative-time'
import type { EmployeeBoardItem } from './task-board-model'

// What a board card shows, chosen by the person the way other boards offer it
// (飞书 卡片配置, Notion and Linear display properties, Jira card layout). The
// defaults follow what those boards lead with: the due date first, then what
// tells a card is alive. A view preference of this browser: it never changes a
// task, and a shared report keeps the defaults.
export const CARD_CONTENT_FIELDS = ['project', 'summary', 'tags', 'priority'] as const
export const CARD_TIME_FIELDS = ['due', 'done', 'column', 'updated', 'started', 'created'] as const
export type CardField = typeof CARD_CONTENT_FIELDS[number] | typeof CARD_TIME_FIELDS[number]

const ALL_FIELDS: readonly CardField[] = [...CARD_CONTENT_FIELDS, ...CARD_TIME_FIELDS]
export const DEFAULT_CARD_FIELDS: readonly CardField[] = ['project', 'summary', 'tags', 'priority', 'due', 'done', 'updated']
export const CARD_FIELDS_KEY = 'fuli:jefa:card-fields:v1'

function storedFields(): CardField[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CARD_FIELDS_KEY) ?? 'null')
    return Array.isArray(value) ? ALL_FIELDS.filter(field => value.includes(field)) : null
  } catch {
    return null
  }
}

export function useBoardCardFields() {
  const chosen = ref<readonly CardField[]>(storedFields() ?? DEFAULT_CARD_FIELDS)
  const fields = computed(() => new Set(chosen.value))
  function save(next: readonly CardField[]) {
    chosen.value = next
    try { localStorage.setItem(CARD_FIELDS_KEY, JSON.stringify(next)) } catch { /* It still applies to this page. */ }
  }
  return {
    fields,
    isDefault: computed(() => chosen.value.length === DEFAULT_CARD_FIELDS.length && DEFAULT_CARD_FIELDS.every(field => fields.value.has(field))),
    toggle: (field: CardField) => save(fields.value.has(field) ? chosen.value.filter(item => item !== field) : [...chosen.value, field]),
    reset: () => save(DEFAULT_CARD_FIELDS),
  }
}

export interface CardTime { key: CardField; text: string; title: string; tone?: 'overdue' | 'soon' }

const DAY = 86_400_000
const HOUR = 3_600_000
const EXACT = { dateStyle: 'medium', timeStyle: 'short' } as const

const calendarDay = (at: Date) => Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())

// A date short enough for a card; the year only when it is not this one.
function shortDate(at: Date, now: Date) {
  return new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).format(at)
}

function dueTime(item: EmployeeBoardItem, now: Date): CardTime | null {
  if (!item.dueDate) return null
  const [year, month, day] = item.dueDate.split('-').map(Number) as [number, number, number]
  const due = new Date(year, month - 1, day)
  const date = shortDate(due, now)
  const left = Math.round((calendarDay(due) - calendarDay(now)) / DAY)
  const base = { key: 'due' as const, title: t('employees.card.dueTitle', { date }) }
  if (item.status === 'done') return { ...base, text: t('employees.card.due', { date }) }
  if (left < 0) return { ...base, text: t('employees.card.overdue', { count: -left }), tone: 'overdue' }
  if (left === 0) return { ...base, text: t('employees.card.dueToday'), tone: 'soon' }
  if (left === 1) return { ...base, text: t('employees.card.dueTomorrow'), tone: 'soon' }
  return { ...base, text: t('employees.card.due', { date }) }
}

function columnTime(value: string, now: Date): CardTime {
  const span = now.getTime() - Date.parse(value)
  const text = span >= DAY ? t('employees.card.columnDays', { count: Math.floor(span / DAY) })
    : span >= HOUR ? t('employees.card.columnHours', { count: Math.floor(span / HOUR) }) : t('employees.card.columnNew')
  return { key: 'column', text, title: exact(value) }
}

const exact = (value: string) => formatDateTime(value, currentLocale(), EXACT, { missing: '' })

function dated(key: CardField, label: string, value: string | undefined, now: Date): CardTime | null {
  return value ? { key, text: t(`employees.card.${label}`, { date: shortDate(new Date(value), now) }), title: exact(value) } : null
}

/** The chosen times a card can state, in reading order; a time the task does not have is left out. */
export function cardTimes(item: EmployeeBoardItem, fields: ReadonlySet<CardField>, now: Date): CardTime[] {
  const updated = item.updatedAt ? formatRelativeTime(item.updatedAt, currentLocale(), now.getTime()) : null
  const times: Record<typeof CARD_TIME_FIELDS[number], () => CardTime | null> = {
    due: () => dueTime(item, now),
    done: () => dated('done', 'done', item.acceptedAt, now),
    column: () => (item.columnSince && item.status !== 'done' ? columnTime(item.columnSince, now) : null),
    updated: () => (updated ? { key: 'updated', text: t('employees.card.updated', { time: updated }), title: exact(item.updatedAt!) } : null),
    started: () => dated('started', 'started', item.startedAt, now),
    created: () => dated('created', 'created', item.createdAt, now),
  }
  return CARD_TIME_FIELDS.flatMap(field => {
    const time = fields.has(field) ? times[field]() : null
    return time ? [time] : []
  })
}
