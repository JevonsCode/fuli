<script setup lang="ts">
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { validKeyReference } from './model'

// The name a connection's key is saved under: typed, or picked from the names
// this computer already knows. A name the server would refuse says why here.
const props = defineProps<{ modelValue: string; known: readonly string[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const current = computed(() => props.modelValue.trim())
const invalid = computed(() => Boolean(current.value) && !validKeyReference(current.value))
</script>

<template>
  <Field>
    <FieldLabel for="model-role-secret-ref">{{ t('modelSettings.secretRef') }}</FieldLabel>
    <Input id="model-role-secret-ref" :model-value="modelValue" autocomplete="off" spellcheck="false" :disabled="disabled"
      :aria-invalid="invalid || undefined" data-model-secret-ref @update:model-value="value => emit('update:modelValue', String(value))" />
    <p v-if="invalid" role="alert" class="model-secret-error" data-model-secret-ref-error>{{ t('modelSettings.secretRefInvalid') }}</p>
    <FieldDescription v-else>{{ t('modelSettings.secretRefHint') }}</FieldDescription>
    <div v-if="known.length" class="model-secret-known" role="group" :aria-label="t('modelSettings.savedKeys')">
      <span>{{ t('modelSettings.savedKeys') }}</span>
      <Button v-for="name in known" :key="name" type="button" size="sm" :variant="name === current ? 'default' : 'outline'" :disabled="disabled"
        :aria-pressed="name === current" :data-model-secret-choice="name" @click="emit('update:modelValue', name)">
        {{ name }}
      </Button>
    </div>
  </Field>
</template>

<style scoped>
.model-secret-error { margin: 0; color: var(--color-danger); font-size: 13px; }
.model-secret-known { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.model-secret-known > span { color: var(--color-muted); font-size: 13px; }
</style>
