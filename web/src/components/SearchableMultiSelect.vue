<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

import type { SearchableSelectOption } from '@/components/SearchableSelect.vue'
import { currentLocale, t } from '@/i18n'

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: readonly SearchableSelectOption[]
  label: string
  controlId?: string
  placeholder?: string
  searchPlaceholder?: string
  searchable?: boolean
  disabled?: boolean
  required?: boolean
}>(), {
  controlId: undefined,
  placeholder: undefined,
  searchPlaceholder: undefined,
  searchable: undefined,
  disabled: false,
  required: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
  change: [value: string[]]
}>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const optionsList = ref<HTMLElement | null>(null)
const open = ref(false)
const openUp = ref(false)
const query = ref('')
const generatedId = useId().replace(/[^A-Za-z0-9_-]/g, '')
const listId = computed(() => `${props.controlId || `searchable-multi-select-${generatedId}`}-options`)
const selectedValues = computed(() => new Set(props.modelValue))
const selectedOptions = computed(() =>
  props.options.filter(({ value }) => selectedValues.value.has(value)),
)
const selectedSummary = computed(() => {
  if (selectedOptions.value.length === 0) {
    return props.placeholder ?? t('common.searchableSelect.placeholder')
  }
  if (selectedOptions.value.length === 1) return selectedOptions.value[0].label
  return t('common.searchableSelect.selectedCount', { count: selectedOptions.value.length })
})
const resolvedSearchPlaceholder = computed(
  () => props.searchPlaceholder ?? t('common.searchableSelect.searchPlaceholder'),
)
const showSearch = computed(() => props.searchable ?? props.options.length > 5)
const filteredOptions = computed(() => {
  const locale = currentLocale()
  const needle = query.value.trim().toLocaleLowerCase(locale)
  if (!needle) return props.options
  return props.options.filter((option) =>
    [option.label, option.value, option.meta, option.search]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase(locale)
      .includes(needle),
  )
})

watch(() => props.disabled, (disabled) => {
  if (disabled) close()
})

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

async function toggle() {
  if (open.value) close()
  else await show()
}

async function show() {
  if (props.disabled) return
  query.value = ''
  positionPanel()
  open.value = true
  await nextTick()
  if (showSearch.value) searchInput.value?.focus()
  else selectedOrFirstOption()?.focus()
}

function close({ restoreFocus = false } = {}) {
  open.value = false
  openUp.value = false
  query.value = ''
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function choose(option: SearchableSelectOption) {
  if (props.disabled || option.disabled) return
  const next = selectedValues.value.has(option.value)
    ? props.modelValue.filter((value) => value !== option.value)
    : [...props.modelValue, option.value]
  emit('update:modelValue', next)
  emit('change', next)
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return
  event.preventDefault()
  if (open.value && ['Enter', ' '].includes(event.key)) close()
  else void show()
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close({ restoreFocus: true })
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    firstOption()?.focus()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    firstOption()?.click()
  }
}

function onOptionKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close({ restoreFocus: true })
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const options = optionButtons()
  const currentIndex = options.indexOf(event.currentTarget as HTMLButtonElement)
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? options.length - 1
      : event.key === 'ArrowDown'
        ? Math.min(options.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1)
  options[nextIndex]?.focus()
}

function onDocumentPointerDown(event: PointerEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) close()
}

function onFocusout(event: FocusEvent) {
  const nextTarget = event.relatedTarget as Node | null
  if (nextTarget && root.value?.contains(nextTarget)) return
  queueMicrotask(() => {
    if (open.value && !root.value?.contains(document.activeElement)) close()
  })
}

function optionButtons() {
  return [
    ...(optionsList.value?.querySelectorAll<HTMLButtonElement>(
      '.searchable-select-option:not(:disabled)',
    ) ?? []),
  ]
}

function firstOption() {
  return optionButtons()[0] ?? null
}

function selectedOrFirstOption() {
  return optionButtons().find(
    (option) => option.getAttribute('aria-selected') === 'true',
  ) ?? firstOption()
}

function positionPanel() {
  const bounds = trigger.value?.getBoundingClientRect()
  openUp.value = Boolean(
    bounds
    && window.innerHeight - bounds.bottom < 270
    && bounds.top > 270,
  )
}
</script>

<template>
  <div
    ref="root"
    class="searchable-select searchable-multi-select"
    :class="{ open, 'open-up': openUp, disabled }"
    :data-select-id="controlId"
    @focusout="onFocusout"
  >
    <button
      ref="trigger"
      type="button"
      class="searchable-select-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-label="label"
      :aria-required="required"
      :disabled="disabled"
      @pointerdown.stop
      @click.stop="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="searchable-select-current">
        <span class="searchable-select-current-label">{{ selectedSummary }}</span>
        <small v-if="selectedOptions.length > 1" class="searchable-select-current-meta">
          {{ selectedOptions.map(({ label }) => label).join(' · ') }}
        </small>
      </span>
      <i class="searchable-select-arrow" aria-hidden="true" />
    </button>

    <div class="searchable-select-panel" :hidden="!open">
      <div v-if="showSearch" class="searchable-select-search">
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          autocomplete="off"
          :placeholder="resolvedSearchPlaceholder"
          :aria-label="t('common.searchableSelect.searchAria', { label })"
          @keydown="onSearchKeydown"
        />
      </div>
      <div
        :id="listId"
        ref="optionsList"
        class="searchable-select-options"
        role="listbox"
        aria-multiselectable="true"
      >
        <button
          v-for="option in filteredOptions"
          :key="option.value"
          type="button"
          class="searchable-select-option"
          role="option"
          :aria-selected="selectedValues.has(option.value)"
          :disabled="option.disabled"
          @mousedown.prevent
          @click="choose(option)"
          @keydown="onOptionKeydown"
        >
          <span class="searchable-select-option-copy">
            <strong>{{ option.label }}</strong>
            <small v-if="option.meta">{{ option.meta }}</small>
          </span>
          <i class="searchable-select-check" aria-hidden="true" />
        </button>
      </div>
      <p v-if="filteredOptions.length === 0" class="searchable-select-empty">
        {{ t('common.searchableSelect.noMatches') }}
      </p>
    </div>
  </div>
</template>
