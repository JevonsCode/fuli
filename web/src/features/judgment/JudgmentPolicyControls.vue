<script setup lang="ts">
import { judgmentText } from './judgment-copy'
import { JUDGMENT_CLIENTS, JUDGMENT_MODES, JUDGMENT_QUALITIES, type JudgmentPolicySelection } from './judgment-types'

// One project's Tonborg policy as three compact choices. Every change is a
// whole new selection; the owner saves it. Quality and client matter only
// when Tonborg may act, as on the default card.
const props = defineProps<{ modelValue: JudgmentPolicySelection; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [JudgmentPolicySelection] }>()

function choose<K extends keyof JudgmentPolicySelection>(key: K, value: string) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<template>
  <div class="judgment-policy-controls">
    <label>
      <span>{{ judgmentText('mode.title') }}</span>
      <select data-select="judgment-mode" :value="modelValue.mode" :disabled="disabled" @change="choose('mode', ($event.target as HTMLSelectElement).value)">
        <option v-for="mode in JUDGMENT_MODES" :key="mode" :value="mode">{{ judgmentText(`mode.${mode}`) }}</option>
      </select>
    </label>
    <template v-if="modelValue.mode !== 'manual'">
      <label>
        <span>{{ judgmentText('quality.title') }}</span>
        <select data-select="judgment-quality" :value="modelValue.quality" :disabled="disabled" @change="choose('quality', ($event.target as HTMLSelectElement).value)">
          <option v-for="quality in JUDGMENT_QUALITIES" :key="quality" :value="quality">{{ judgmentText(`quality.${quality}`) }}</option>
        </select>
      </label>
      <label>
        <span>{{ judgmentText('client.title') }}</span>
        <select data-select="judgment-client" :value="modelValue.client" :disabled="disabled" @change="choose('client', ($event.target as HTMLSelectElement).value)">
          <option v-for="client in JUDGMENT_CLIENTS" :key="client" :value="client">{{ judgmentText(`client.${client}`) }}</option>
        </select>
      </label>
    </template>
  </div>
</template>

<style scoped>
.judgment-policy-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.judgment-policy-controls label { display: grid; gap: 5px; min-width: 0; }
.judgment-policy-controls span { color: var(--color-muted); font-size: 12px; }
.judgment-policy-controls select { min-height: var(--control-height); padding: 6px 10px; border: 1px solid var(--color-control-border); border-radius: var(--radius-control); color: var(--color-ink); background: var(--color-surface); font: inherit; font-size: 13px; }
</style>
