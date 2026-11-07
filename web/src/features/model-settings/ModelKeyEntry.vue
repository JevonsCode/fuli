<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { endpointOrigin, readSavedKeys, saveModelKey, validKeyReference } from './model'

// The API key behind one key reference, saved on this computer. The field is
// write-only: after saving it empties, and the page shows only that a key is
// saved under the reference, never the key. A key is saved for the endpoint
// typed above it and is sent to that origin only (secret-store.js); a key
// saved for another origin must be saved again here before the role uses it.
const props = defineProps<{ reference: string; endpoint: string; disabled?: boolean }>()
const emit = defineEmits<{ keys: [saved: string[]] }>()

const saved = ref<Set<string> | null>(null)
const origins = ref<Record<string, string | null>>({})
const key = ref('')
const saving = ref(false)
const message = ref('')
const error = ref('')
const reference = computed(() => props.reference.trim())
const origin = computed(() => endpointOrigin(props.endpoint))
const usable = computed(() => validKeyReference(reference.value) && origin.value !== null)
const hasKey = computed(() => usable.value && Boolean(saved.value?.has(reference.value)))
// The saved key goes to another origin than the endpoint typed now, or to none yet.
const tiedElsewhere = computed(() => hasKey.value && origins.value[reference.value] !== origin.value)

onMounted(async () => {
  try {
    const keys = await readSavedKeys()
    saved.value = new Set(keys.saved)
    origins.value = keys.origins ?? {}
    emit('keys', [...saved.value])
  } catch { saved.value = null }
})
watch(reference, () => { message.value = ''; error.value = '' })

async function save() {
  if (!usable.value || !key.value || saving.value) return
  saving.value = true
  message.value = ''
  error.value = ''
  try {
    await saveModelKey(reference.value, key.value, props.endpoint.trim())
    saved.value = new Set([...saved.value ?? [], reference.value])
    origins.value = { ...origins.value, [reference.value]: origin.value }
    emit('keys', [...saved.value])
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
      {{ !validKeyReference(reference) ? t('modelSettings.key.needsReference') : !origin ? t('modelSettings.key.needsEndpoint')
        : tiedElsewhere ? t('modelSettings.key.elsewhere', { reference, origin: origins[reference] ?? '-' })
        : hasKey ? t('modelSettings.key.present', { reference, origin }) : t('modelSettings.key.absent', { reference }) }}
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
