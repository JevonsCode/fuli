<script setup lang="ts">
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  controlId?: string
  type?: 'text' | 'url' | 'search'
  placeholder?: string
  disabled?: boolean
  required?: boolean
  multiline?: boolean
  rows?: number
  name?: string
}>(), {
  controlId: undefined,
  type: 'text',
  placeholder: undefined,
  disabled: false,
  required: false,
  multiline: false,
  rows: 3,
  name: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function updateValue(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement | HTMLTextAreaElement).value)
}
</script>

<template>
  <label class="text-field">
    <span>{{ label }}</span>
    <textarea
      v-if="multiline"
      v-bind="$attrs"
      :id="controlId"
      :value="modelValue"
      :name="name"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :rows="rows"
      @input="updateValue"
    />
    <input
      v-else
      v-bind="$attrs"
      :id="controlId"
      :value="modelValue"
      :name="name"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      @input="updateValue"
    />
  </label>
</template>

<style scoped>
.text-field {
  display: grid;
  gap: 5px;
  min-width: 0;
  color: var(--color-muted);
  font-size: 12px;
}

.text-field input,
.text-field textarea {
  width: 100%;
  min-width: 0;
}
</style>
