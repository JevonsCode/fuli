<script setup lang="ts">
// FULI composition of reka-ui's Listbox: a multiple choice list that is
// always visible, with a search field, for managing a set inside a dialog.
// (A popup choice is OptionCombobox; this one has no popup, so Escape still
// belongs to the dialog.) `label` names the list and heads it with the count.
import { ListboxContent, ListboxFilter, ListboxGroup, ListboxGroupLabel, ListboxItem, ListboxItemIndicator, ListboxRoot, useFilter } from "reka-ui"
import { computed, ref, useId } from "vue"
import { t } from "@/i18n"
import UiIcon from "@/ui/UiIcon.vue"
import { fromItemValue, groupOptions, optionSearchText, toItemValue, type SelectOption } from "../select/option"
import SelectionActions from "../select/SelectionActions.vue"

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: readonly SelectOption[]
  label: string
  hint?: string
  disabled?: boolean
}>(), { hint: undefined, disabled: false })

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>()

const labelId = `option-listbox-${useId()}`
const query = ref("")
const { contains } = useFilter({ sensitivity: "base" })
const shown = computed(() => groupOptions(props.options.filter(option => !query.value || contains(optionSearchText(option), query.value))))
const order = computed(() => new Map(props.options.map((option, index) => [option.value, index])))

function emitValues(values: string[]) {
  const rank = (value: string) => order.value.get(value) ?? Number.MAX_SAFE_INTEGER
  emit("update:modelValue", [...values].sort((a, b) => rank(a) - rank(b)))
}

function choose(next: unknown) {
  if (Array.isArray(next)) emitValues(next.map(value => fromItemValue(String(value))))
}
</script>

<template>
  <div class="grid min-w-0 gap-2" data-slot="option-listbox">
    <span :id="labelId" class="text-sm font-medium text-foreground-soft">{{ label }}</span>
    <ListboxRoot
      :model-value="modelValue.map(toItemValue)"
      multiple
      :disabled="disabled"
      class="overflow-hidden rounded-md border border-border bg-card data-[disabled]:opacity-45"
      @update:model-value="choose"
    >
      <ListboxFilter
        v-model="query"
        type="search"
        class="w-full rounded-none border-0 border-b border-border bg-transparent px-3 shadow-none focus:shadow-none"
        :placeholder="t('ui.select.search')"
        :aria-label="t('ui.select.searchAria', { label })"
      />
      <ListboxContent class="max-h-72 overflow-y-auto p-1 outline-none" :aria-labelledby="labelId">
        <p v-if="!shown.length" class="py-6 text-center text-sm text-muted-foreground">{{ options.length ? t('ui.select.noMatches') : t('ui.select.noOptions') }}</p>
        <ListboxGroup v-for="group in shown" :key="group.heading ?? ''" class="p-0">
          <ListboxGroupLabel v-if="group.heading" class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{{ group.heading }}</ListboxGroupLabel>
          <ListboxItem
            v-for="option in group.options"
            :key="option.value"
            :value="toItemValue(option.value)"
            :disabled="option.disabled"
            :data-option-value="option.value"
            class="relative flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[state=checked]:bg-muted data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-45"
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{{ option.label }}</span>
              <span v-if="option.meta" class="truncate text-xs text-muted-foreground">{{ option.meta }}</span>
            </span>
            <ListboxItemIndicator class="ml-auto"><UiIcon name="check" :size="16" class="text-primary" /></ListboxItemIndicator>
          </ListboxItem>
        </ListboxGroup>
      </ListboxContent>
      <SelectionActions :options="options" :model-value="modelValue" :disabled="disabled" @update:model-value="emitValues" />
    </ListboxRoot>
    <p v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</p>
  </div>
</template>
