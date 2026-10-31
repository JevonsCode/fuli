<script setup lang="ts">
// The bulk row under a multiple choice list: how many are chosen, select all,
// invert and clear all. Disabled options keep their state. Buttons keep focus
// where it was (mousedown.prevent), so the list stays keyboard-driven.
import { computed } from "vue"
import { Button } from "@/components/ui/button"
import { t } from "@/i18n"
import type { SelectOption } from "./option"

const props = defineProps<{
  options: readonly SelectOption[]
  modelValue: readonly string[]
  disabled?: boolean
}>()
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>()

const chosen = computed(() => new Set(props.modelValue))
const enabled = computed(() => props.options.filter(option => !option.disabled))
const locked = computed(() => props.options.filter(option => option.disabled && chosen.value.has(option.value)).map(option => option.value))
const allChosen = computed(() => enabled.value.every(option => chosen.value.has(option.value)))
const chosenCount = computed(() => props.options.filter(option => chosen.value.has(option.value)).length)

function selectAll() { emit("update:modelValue", props.options.filter(option => !option.disabled || chosen.value.has(option.value)).map(option => option.value)) }
function invert() { emit("update:modelValue", [...locked.value, ...enabled.value.filter(option => !chosen.value.has(option.value)).map(option => option.value)]) }
function clearAll() { emit("update:modelValue", locked.value) }
</script>

<template>
  <div class="flex flex-wrap items-center gap-1 border-t border-border p-1" data-slot="selection-actions">
    <span class="mr-auto px-2 text-xs text-muted-foreground" role="status" data-selection-count>{{ t('ui.select.count', { selected: chosenCount, total: options.length }) }}</span>
    <Button variant="ghost" size="xs" data-select-action="all" :disabled="disabled || !enabled.length || allChosen" @mousedown.prevent @click="selectAll">{{ t('ui.select.selectAll') }}</Button>
    <Button variant="ghost" size="xs" data-select-action="invert" :disabled="disabled || !enabled.length" @mousedown.prevent @click="invert">{{ t('ui.select.invert') }}</Button>
    <Button variant="ghost" size="xs" data-select-action="clear" :disabled="disabled || chosenCount === locked.length" @mousedown.prevent @click="clearAll">{{ t('ui.select.clearAll') }}</Button>
    <slot />
  </div>
</template>
