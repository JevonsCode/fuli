<script setup lang="ts">
// The person's Agent naming style (Agent 取名风格). With no saved style the
// field starts with FULI's own naming rule as editable text, so the person
// sees what they would change. The model stays what the server stores: ''
// means FULI generates the names, so the untouched (or restored) default is
// never saved as a style and recruiting keeps FULI's generated names.
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { t } from '@/i18n'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [style: string] }>()

const defaultStyle = computed(() => t('settings.agentNaming.default'))
const draft = ref(props.modelValue || defaultStyle.value)
const isDefault = computed(() => draft.value.trim() === defaultStyle.value)

function savedStyle(text: string) {
  return text.trim() === defaultStyle.value ? '' : text
}

watch(draft, (text) => {
  const style = savedStyle(text)
  if (style !== props.modelValue) emit('update:modelValue', style)
})
// A load or save answer replaces the draft unless it already says the same.
watch(() => props.modelValue, (style) => {
  if (style !== savedStyle(draft.value)) draft.value = style || defaultStyle.value
})
// The untouched default follows the console language.
watch(defaultStyle, (now, before) => {
  if (draft.value.trim() === before) draft.value = now
})
</script>

<template>
  <div class="agent-naming-field">
    <Textarea v-model="draft" rows="2" maxlength="500" :placeholder="defaultStyle"
      aria-labelledby="settings-agent-naming-title" aria-describedby="settings-agent-naming-description settings-agent-naming-count"
      data-agent-naming-style data-settings-field="agentNamingStyle" />
    <div class="agent-naming-actions">
      <small id="settings-agent-naming-count">{{ t('settings.agentNaming.count', { count: draft.length }) }}</small>
      <Button type="button" variant="ghost" size="sm" :disabled="isDefault" data-agent-naming-reset @click="draft = defaultStyle">
        {{ t('settings.agentNaming.reset') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.agent-naming-field { display: grid; gap: 8px; }
.agent-naming-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.agent-naming-actions small { color: var(--color-muted); font-size: var(--text-meta); }
</style>
