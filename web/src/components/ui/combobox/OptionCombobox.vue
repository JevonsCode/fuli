<script setup lang="ts" generic="V extends string | string[]">
// FULI composition of the shadcn-vue Combobox for a list of options: type to
// filter, one choice or (`multiple`) many. Many choices show as removable
// chips in the field (reka-ui TagsInput: Backspace marks the last chip, a
// second Backspace removes it); past `maxChips` the rest are counted ("+3").
// `searchable: false` keeps the field from taking typing, for a short
// multiple-choice list. `label` names the control; `field` also shows it above.
// `loading` shows an inline indicator above the options it already has.
import type { HTMLAttributes } from "vue"
import { ComboboxInput } from "reka-ui"
import { computed, useId } from "vue"
import GrowthLoading from "@/components/GrowthLoading.vue"
import { t } from "@/i18n"
import { cn } from "@/lib/class-names"
import { FIELD_FOCUS_WITHIN, FIELD_LOOK } from "../field-look"
import UiIcon from "@/ui/UiIcon.vue"
import { fromItemValue, groupOptions, optionSearchText, toItemValue, type SelectOption } from "../select/option"
import SelectionActions from "../select/SelectionActions.vue"
import { TagsInput, TagsInputInput, TagsInputItem, TagsInputItemDelete, TagsInputItemText } from "../tags-input"
import Combobox from "./Combobox.vue"
import ComboboxAnchor from "./ComboboxAnchor.vue"
import ComboboxEmpty from "./ComboboxEmpty.vue"
import ComboboxGroup from "./ComboboxGroup.vue"
import ComboboxItem from "./ComboboxItem.vue"
import ComboboxItemIndicator from "./ComboboxItemIndicator.vue"
import ComboboxList from "./ComboboxList.vue"
import ComboboxTrigger from "./ComboboxTrigger.vue"
import ComboboxViewport from "./ComboboxViewport.vue"

const props = withDefaults(defineProps<{
  modelValue: V
  options: readonly SelectOption[]
  label: string
  multiple?: boolean
  searchable?: boolean
  field?: boolean
  placeholder?: string
  /** Multiple: shown in place of the chips while every option is chosen. */
  allLabel?: string
  /** Multiple: shown in place of the chips at all times, such as a count. */
  summary?: string
  maxChips?: number
  /** A note under the list, such as what the choice affects. */
  hint?: string
  disabled?: boolean
  loading?: boolean
  required?: boolean
  name?: string
  controlId?: string
  size?: "sm" | "default"
  class?: HTMLAttributes["class"]
}>(), {
  multiple: false, searchable: true, field: false, placeholder: undefined, allLabel: undefined, summary: undefined, maxChips: 2, hint: undefined,
  disabled: false, loading: false, required: false, name: undefined, controlId: undefined, size: "default", class: undefined,
})

const emit = defineEmits<{ "update:modelValue": [value: V] }>()
defineSlots<{ actions?: () => unknown }>()

// TagsInput adds typed text as a chip on its delimiter; chips here only come from the list.
const NO_DELIMITER = /(?!)/

const inputId = props.controlId ?? `option-combobox-${useId()}`
const groups = computed(() => groupOptions(props.options))
const optionByItem = computed(() => new Map(props.options.map(option => [toItemValue(option.value), option])))
const order = computed(() => new Map(props.options.map((option, index) => [option.value, index])))

const chosenValues = computed(() => Array.isArray(props.modelValue) ? props.modelValue as string[] : [])
const itemModel = computed(() => {
  if (props.multiple) return chosenValues.value.map(toItemValue)
  const value = props.modelValue as string
  return optionByItem.value.has(toItemValue(value)) ? toItemValue(value) : (value || undefined)
})
const chips = computed(() => itemModel.value as string[])
const shownChips = computed(() => chips.value.slice(0, props.maxChips))
const allChosen = computed(() => Boolean(props.allLabel) && props.options.length > 0
  && props.options.every(option => chosenValues.value.includes(option.value)))
const placeholderText = computed(() => props.placeholder ?? t("ui.select.placeholder"))

function labelOf(itemValue: unknown) {
  if (typeof itemValue !== "string") return ""
  // Before the options arrive the field stays empty rather than showing a raw value.
  return optionByItem.value.get(itemValue)?.label ?? (props.options.length ? fromItemValue(itemValue) : "")
}

function emitValues(values: string[]) {
  const rank = (value: string) => order.value.get(value) ?? Number.MAX_SAFE_INTEGER
  emit("update:modelValue", [...values].sort((a, b) => rank(a) - rank(b)) as V)
}

function choose(next: unknown) {
  if (Array.isArray(next)) emitValues(next.map(value => fromItemValue(String(value))))
  else if (typeof next === "string") emit("update:modelValue", fromItemValue(next) as V)
}

const fieldClass = computed(() => cn(
  FIELD_LOOK, FIELD_FOCUS_WITHIN,
  "flex w-full min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden px-2 text-base",
  "data-[disabled]:cursor-not-allowed data-[disabled]:bg-muted data-[disabled]:text-muted-foreground",
  props.size === "sm" ? "min-h-(--control-height-sm) py-0.5 text-sm" : "min-h-(--control-height) py-1",
))
const inputClass = "min-h-0 min-w-8 flex-1 border-0 bg-transparent p-1 shadow-none outline-none focus:shadow-none disabled:cursor-not-allowed disabled:bg-transparent read-only:cursor-pointer"
</script>

<template>
  <div :class="cn('min-w-0', field && 'ui-field', props.class)" data-slot="option-combobox" :data-select-id="controlId">
    <label v-if="field" :for="inputId">{{ label }}</label>
    <Combobox
      :model-value="itemModel"
      :multiple="multiple"
      :disabled="disabled"
      :name="name"
      :required="required"
      open-on-click
      @update:model-value="choose"
    >
      <ComboboxAnchor :as-child="multiple" :class="multiple ? undefined : fieldClass" :data-disabled="disabled ? '' : undefined">
        <TagsInput v-if="multiple" :model-value="chips" :display-value="labelOf" :delimiter="NO_DELIMITER" :disabled="disabled" :class="fieldClass" @update:model-value="choose">
          <span v-if="summary" class="min-w-0 truncate px-1 text-sm" data-select-summary>{{ summary }}</span>
          <span v-else-if="allChosen" class="min-w-0 truncate px-1 text-sm" data-select-all-label>{{ allLabel }}</span>
          <template v-else>
            <TagsInputItem v-for="value in shownChips" :key="value" :value="value" class="max-w-40" data-select-chip>
              <TagsInputItemText />
              <TagsInputItemDelete />
            </TagsInputItem>
            <span v-if="chips.length > shownChips.length" class="shrink-0 text-xs text-muted-foreground" data-select-overflow>+{{ chips.length - shownChips.length }}</span>
          </template>
          <ComboboxInput as-child>
            <TagsInputInput
              :id="inputId"
              :class="inputClass"
              :placeholder="chips.length || summary ? undefined : placeholderText"
              :readonly="!searchable"
              :aria-label="field ? undefined : label"
              @keydown.enter.prevent
            />
          </ComboboxInput>
          <ComboboxTrigger class="shrink-0 cursor-pointer text-muted-foreground"><UiIcon name="chevron-down" :size="16" /></ComboboxTrigger>
        </TagsInput>
        <template v-else>
          <ComboboxInput
            :id="inputId"
            :class="inputClass"
            :display-value="labelOf"
            :placeholder="placeholderText"
            :readonly="!searchable"
            :aria-label="field ? undefined : label"
          />
          <ComboboxTrigger class="shrink-0 cursor-pointer text-muted-foreground"><UiIcon name="chevron-down" :size="16" /></ComboboxTrigger>
        </template>
      </ComboboxAnchor>
      <ComboboxList class="w-(--reka-popper-anchor-width) min-w-56">
        <ComboboxViewport :aria-busy="loading || undefined">
          <GrowthLoading v-if="loading" variant="inline" class="px-2 py-1.5" :label="t('ui.select.loading')" />
          <ComboboxEmpty v-else>{{ options.length ? t('ui.select.noMatches') : t('ui.select.noOptions') }}</ComboboxEmpty>
          <ComboboxGroup v-for="group in groups" :key="group.heading ?? ''" :heading="group.heading">
            <ComboboxItem
              v-for="option in group.options"
              :key="option.value"
              :value="toItemValue(option.value)"
              :data-option-value="option.value"
              :text-value="optionSearchText(option)"
              :disabled="option.disabled"
            >
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate">{{ option.label }}</span>
                <span v-if="option.meta" class="truncate text-xs text-muted-foreground">{{ option.meta }}</span>
              </span>
              <ComboboxItemIndicator><UiIcon name="check" :size="16" class="text-primary" /></ComboboxItemIndicator>
            </ComboboxItem>
          </ComboboxGroup>
        </ComboboxViewport>
        <SelectionActions v-if="multiple" :options="options" :model-value="chosenValues" :disabled="disabled" @update:model-value="emitValues">
          <slot name="actions" />
        </SelectionActions>
        <p v-if="hint" class="border-t border-border px-3 py-2 text-xs text-muted-foreground">{{ hint }}</p>
      </ComboboxList>
    </Combobox>
  </div>
</template>
