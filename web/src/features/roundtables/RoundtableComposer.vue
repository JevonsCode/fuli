<script setup lang="ts">
import { ref } from 'vue'
import { t } from '@/i18n'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { UiIcon } from '@/ui'
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
  <form class="rt-composer" data-roundtable-composer @submit.prevent="send">
    <RadioGroup :model-value="mode" :aria-label="t('roundtable.composer.modeLabel')" class="rt-modes"
      :disabled="sending || switching || disabled" @update:model-value="value => emit('update:mode', value as RoundtableDelivery)">
      <label v-for="option in MODES" :key="option" class="rt-mode" :data-roundtable-mode="option"
        :data-selected="mode === option || undefined" :title="t(`roundtable.composer.hints.${option}`)">
        <RadioGroupItem :value="option" class="rt-mode-radio" />
        <span>{{ t(`roundtable.composer.modes.${option}`) }}</span>
      </label>
      <GrowthLoading v-if="switching" variant="inline" :label="t('roundtable.composer.switching')" />
      <small v-else class="rt-mode-hint">{{ t(`roundtable.composer.hints.${mode}`) }}</small>
    </RadioGroup>
    <div class="rt-compose">
      <Textarea v-model="body" class="rt-compose-input" rows="1" :disabled="disabled"
        :aria-label="t('roundtable.composer.label')" :placeholder="t('roundtable.composer.placeholder')" @keydown="key" />
      <Button type="submit" class="rt-send" :loading="sending" :loading-label="t('roundtable.composer.sending')"
        :disabled="disabled || !body.trim()" :aria-label="t('roundtable.composer.send')" :title="t('roundtable.composer.send')" data-roundtable-send>
        <UiIcon name="chevron-up" :size="18" />
      </Button>
    </div>
    <p v-if="error" role="alert" class="rt-compose-error">{{ error }}</p>
  </form>
</template>

<style scoped>
/* Like Messages: one rounded field with a round send button inside its end; how the message travels sits just above. */
.rt-composer { display: grid; flex: 0 0 auto; gap: 8px; padding: 10px 20px 16px; border-top: 1px solid var(--color-border); }
.rt-modes { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding-inline: 6px; }
.rt-mode { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 4px; border-radius: var(--radius-pill); color: var(--color-muted); font-size: var(--text-meta); cursor: pointer; transition: background var(--motion-fast), color var(--motion-fast); }
.rt-mode[data-selected] { color: var(--color-ink); background: var(--color-surface-hover); font-weight: var(--weight-medium); }
.rt-mode-hint { color: var(--color-faint); font-size: var(--text-meta); }
/* The radio stays for keyboards and screen readers; the pill shows the choice. */
.rt-modes :deep(.rt-mode-radio) { position: absolute; width: 1px; height: 1px; opacity: 0; }
.rt-mode:has(:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.rt-compose { display: flex; align-items: flex-end; gap: 8px; padding: 5px 5px 5px 16px; border-radius: 22px; background: var(--color-surface-subtle); box-shadow: inset 0 0 0 1px var(--color-border); transition: box-shadow var(--motion-fast); }
.rt-compose:focus-within { box-shadow: inset 0 0 0 1px var(--color-border-strong), 0 0 0 4px var(--color-surface-hover); }
.rt-compose-input { min-height: 34px; max-height: 200px; padding: 7px 0; border: 0; resize: none; background: transparent; box-shadow: none; }
.rt-compose-input:focus-visible { outline: none; box-shadow: none; }
.rt-send { flex: none; width: 34px; height: 34px; padding: 0; border-radius: 50%; }
.rt-compose-error { margin: 0; padding-inline: 16px; color: var(--color-danger); font-size: var(--text-meta); }
@media (max-width: 480px) { .rt-composer { padding: 8px 12px 12px; } }
</style>
