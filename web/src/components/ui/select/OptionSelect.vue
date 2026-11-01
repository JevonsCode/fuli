<script setup lang="ts">
// FULI composition of the shadcn-vue Select for a list of options: one
// choice from a short fixed list, no search (a long or data-driven list uses
// OptionCombobox). `label` names the control; `field` also shows it above.
// `loading` shows an inline indicator in the list while options arrive.
import type { HTMLAttributes } from "vue"
import { computed, useId } from "vue"
import GrowthLoading from "@/components/GrowthLoading.vue"
import { t } from "@/i18n"
import { cn } from "@/lib/class-names"
import type { ControlSize } from "../control-size"
import { fromItemValue, groupOptions, toItemValue, type SelectOption } from "./option"
import Select from "./Select.vue"
import SelectContent from "./SelectContent.vue"
import SelectGroup from "./SelectGroup.vue"
import SelectItem from "./SelectItem.vue"
import SelectLabel from "./SelectLabel.vue"
import SelectTrigger from "./SelectTrigger.vue"
import SelectValue from "./SelectValue.vue"

const props = withDefaults(defineProps<{
  modelValue: string
  options: readonly SelectOption[]
  label: string
  field?: boolean
  placeholder?: string
  disabled?: boolean
  loading?: boolean
  required?: boolean
  name?: string
  controlId?: string
  size?: ControlSize
  class?: HTMLAttributes["class"]
}>(), { field: false, placeholder: undefined, disabled: false, loading: false, required: false, name: undefined, controlId: undefined, size: "md", class: undefined })

const emit = defineEmits<{ "update:modelValue": [value: string] }>()

const triggerId = props.controlId ?? `option-select-${useId()}`
const groups = computed(() => groupOptions(props.options))
// '' shows the placeholder unless an option stands for it.
const itemValue = computed(() => props.options.some(option => option.value === props.modelValue) ? toItemValue(props.modelValue) : props.modelValue)

function choose(value: unknown) {
  if (typeof value === "string") emit("update:modelValue", fromItemValue(value))
}
</script>

<template>
  <div :class="cn('min-w-0', field && 'ui-field', props.class)" data-slot="option-select" :data-select-id="controlId">
    <label v-if="field" :for="triggerId">{{ label }}</label>
    <Select :model-value="itemValue" :disabled="disabled" :required="required" :name="name" @update:model-value="choose">
      <SelectTrigger :id="triggerId" class="w-full min-w-0" :size="size" :aria-label="field ? undefined : label" :aria-busy="loading || undefined">
        <SelectValue :placeholder="placeholder ?? t('ui.select.placeholder')" />
      </SelectTrigger>
      <SelectContent>
        <GrowthLoading v-if="loading" variant="inline" class="px-2 py-1.5" :label="t('ui.select.loading')" />
        <p v-else-if="!options.length" class="m-0 py-6 text-center text-sm text-muted-foreground" data-select-empty>{{ t('ui.select.noOptions') }}</p>
        <SelectGroup v-for="group in groups" :key="group.heading ?? ''">
          <SelectLabel v-if="group.heading">{{ group.heading }}</SelectLabel>
          <SelectItem v-for="option in group.options" :key="option.value" :value="toItemValue(option.value)" :disabled="option.disabled">
            {{ option.label }}
            <template v-if="option.meta" #meta>{{ option.meta }}</template>
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  </div>
</template>
