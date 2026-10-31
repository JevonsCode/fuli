<script setup lang="ts">
import { ref } from 'vue'
import { t } from '@/i18n'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import GrowthLoading from '@/components/GrowthLoading.vue'
import type { RoundtableDelivery } from './roundtable-api'

// The person's message box, pinned under the conversation: how the FLAs
// receive it (board or instant) and the text. Enter sends; Shift+Enter and
// an input method's composition keep typing.
const props = defineProps<{
  mode: RoundtableDelivery
  sending: boolean
  switching?: boolean
  disabled?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ 'update:mode': [RoundtableDelivery]; send: [string] }>()
const MODES: RoundtableDelivery[] = ['board', 'instant']
const body = ref('')

function send() {
  const text = body.value.trim()
  if (!text || props.sending || props.disabled) return
  emit('send', text)
}
function key(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  send()
}
// The page clears the text only after the server recorded the message.
defineExpose({ clear: () => { body.value = '' } })
</script>

<template>
  <form class="roundtable-composer" data-roundtable-composer @submit.prevent="send">
    <RadioGroup :model-value="mode" :aria-label="t('roundtable.composer.modeLabel')" class="roundtable-composer-modes"
      :disabled="sending || switching || disabled" @update:model-value="value => emit('update:mode', value as RoundtableDelivery)">
      <label v-for="option in MODES" :key="option" class="roundtable-composer-mode" :data-roundtable-mode="option"
        :data-selected="mode === option || undefined" :title="t(`roundtable.composer.hints.${option}`)">
        <RadioGroupItem :value="option" />
        <span>{{ t(`roundtable.composer.modes.${option}`) }}</span>
      </label>
      <GrowthLoading v-if="switching" variant="inline" :label="t('roundtable.composer.switching')" />
      <small v-else class="roundtable-composer-hint">{{ t(`roundtable.composer.hints.${mode}`) }}</small>
    </RadioGroup>
    <div class="roundtable-composer-row">
      <Textarea v-model="body" class="roundtable-composer-input" rows="1" :disabled="disabled"
        :aria-label="t('roundtable.composer.label')" :placeholder="t('roundtable.composer.placeholder')" @keydown="key" />
      <Button type="submit" :loading="sending" :loading-label="t('roundtable.composer.sending')"
        :disabled="disabled || !body.trim()" data-roundtable-send>{{ t('roundtable.composer.send') }}</Button>
    </div>
    <p v-if="error" role="alert" class="roundtable-composer-error">{{ error }}</p>
  </form>
</template>

<style scoped>
.roundtable-composer { display: grid; flex: 0 0 auto; gap: 8px; padding: 12px 28px 16px; border-top: 1px solid var(--color-border); }
.roundtable-composer-modes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.roundtable-composer-mode { display: inline-flex; align-items: center; gap: 6px; color: var(--color-muted); font-size: 13px; cursor: pointer; }
.roundtable-composer-mode[data-selected] { color: var(--color-ink); font-weight: 600; }
.roundtable-composer-hint { color: var(--color-faint); font-size: 12px; }
.roundtable-composer-row { display: flex; align-items: flex-end; gap: 8px; }
.roundtable-composer-input { min-height: 40px; max-height: 200px; resize: none; }
.roundtable-composer-error { margin: 0; color: var(--color-danger); font-size: 12px; }
@media (max-width: 480px) { .roundtable-composer { padding: 10px 16px 12px; } }
</style>
