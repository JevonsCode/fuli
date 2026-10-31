<script setup lang="ts">
import { computed } from 'vue'

import { OptionSelect } from '@/components/ui/select'
import { judgmentText } from './judgment-copy'
import { JUDGMENT_CLIENTS, JUDGMENT_MODES, JUDGMENT_QUALITIES, type JudgmentPolicySelection } from './judgment-types'

// One project's Tonborg policy as three compact choices. Every change is a
// whole new selection; the owner saves it. Quality and client matter only
// when Tonborg may act, as on the default card.
const props = defineProps<{ modelValue: JudgmentPolicySelection; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [JudgmentPolicySelection] }>()

const modeOptions = computed(() => JUDGMENT_MODES.map(value => ({ value, label: judgmentText(`mode.${value}`) })))
const qualityOptions = computed(() => JUDGMENT_QUALITIES.map(value => ({ value, label: judgmentText(`quality.${value}`) })))
const clientOptions = computed(() => JUDGMENT_CLIENTS.map(value => ({ value, label: judgmentText(`client.${value}`) })))

function choose<K extends keyof JudgmentPolicySelection>(key: K, value: string) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<template>
  <div class="judgment-policy-controls">
    <OptionSelect field size="sm" data-select="judgment-mode" :label="judgmentText('mode.title')" :options="modeOptions"
      :model-value="modelValue.mode" :disabled="disabled" @update:model-value="choose('mode', $event)" />
    <template v-if="modelValue.mode !== 'manual'">
      <OptionSelect field size="sm" data-select="judgment-quality" :label="judgmentText('quality.title')" :options="qualityOptions"
        :model-value="modelValue.quality" :disabled="disabled" @update:model-value="choose('quality', $event)" />
      <OptionSelect field size="sm" data-select="judgment-client" :label="judgmentText('client.title')" :options="clientOptions"
        :model-value="modelValue.client" :disabled="disabled" @update:model-value="choose('client', $event)" />
    </template>
  </div>
</template>

<style scoped>
.judgment-policy-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
</style>
