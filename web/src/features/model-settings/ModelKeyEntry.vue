<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { readSavedKeys, saveModelKey, validKeyReference } from './model'

// The API key behind one key reference, saved on this computer. The field is
// write-only: after saving it empties, and the page shows only that a key is
// saved under the reference, never the key.
const props = defineProps<{ reference: string; disabled?: boolean }>()

const saved = ref<Set<string> | null>(null)
const key = ref('')
const saving = ref(false)
const message = ref('')
const error = ref('')
const reference = computed(() => props.reference.trim())
const usable = computed(() => validKeyReference(reference.value))
const hasKey = computed(() => usable.value && Boolean(saved.value?.has(reference.value)))

onMounted(async () => {
  try { saved.value = new Set((await readSavedKeys()).saved) } catch { saved.value = null }
})
watch(reference, () => { message.value = ''; error.value = '' })

async function save() {
  if (!usable.value || !key.value || saving.value) return
  saving.value = true
  message.value = ''
  error.value = ''
  try {
    await saveModelKey(reference.value, key.value)
    saved.value = new Set([...saved.value ?? [], reference.value])
    message.value = t('modelSettings.key.saved', { reference: reference.value })
  } catch (cause) {
    error.value = apiErrorReason(cause)
  } finally {
    key.value = ''
    saving.value = false
  }
}
</script>

<template>
  <Field class="model-key-entry" data-model-key-entry>
    <FieldLabel for="model-role-key">{{ t('modelSettings.key.label') }}</FieldLabel>
    <p class="model-key-state" data-model-key-state>
      {{ !usable ? t('modelSettings.key.needsReference') : hasKey ? t('modelSettings.key.present', { reference })
        : t('modelSettings.key.absent', { reference }) }}
    </p>
    <div class="model-key-row">
      <Input id="model-role-key" v-model="key" type="password" autocomplete="new-password" spellcheck="false"
        :placeholder="hasKey ? t('modelSettings.key.replacePlaceholder') : t('modelSettings.key.placeholder')"
        :disabled="disabled || saving || !usable" data-model-key @keydown.enter.prevent="save" />
      <Button type="button" variant="outline" :disabled="disabled || !usable || !key" :loading="saving"
        :loading-label="t('modelSettings.key.saving', { reference })" data-model-key-save @click="save">
        {{ hasKey ? t('modelSettings.key.replace') : t('modelSettings.key.save') }}
      </Button>
    </div>
    <FieldDescription>{{ t('modelSettings.key.hint') }}</FieldDescription>
    <p v-if="message" role="status" class="model-key-state">{{ message }}</p>
    <p v-if="error" role="alert" class="model-key-error">{{ error }}</p>
  </Field>
</template>

<style scoped>
.model-key-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.model-key-row > :first-child { flex: 1 1 220px; min-width: 0; }
.model-key-state { margin: 0; color: var(--color-muted); font-size: 13px; }
.model-key-error { margin: 0; color: var(--color-danger); font-size: 13px; }
</style>
