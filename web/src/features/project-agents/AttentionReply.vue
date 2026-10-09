<script setup lang="ts">
import { computed } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { t } from '@/i18n'
import type { AgentAttention } from './attention-store'
import { attentionReplies, composeAttentionReply, type AttentionReplyDraft } from './attention-replies'
const props = defineProps<{ item: AgentAttention; modelValue: AttentionReplyDraft; busy: boolean; refreshing?: boolean; error: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: AttentionReplyDraft]; submit: [response: string] }>()
const choices = computed(() => attentionReplies(props.item))
const response = computed(() => composeAttentionReply(props.modelValue.choice, props.modelValue.text, choices.value))
function update(patch: Partial<AttentionReplyDraft>) { emit('update:modelValue', { ...props.modelValue, ...patch }) }
function submit() { if (!props.busy && !props.refreshing && response.value && response.value.length <= 4096) emit('submit', response.value) }
</script>

<template>
  <form class="attention-reply" @submit.prevent="submit">
    <div class="attention-question">
      <h3>{{ item.title }}</h3>
      <p>{{ item.requestedAction }}</p>
    </div>
    <UiDisclosure :key="item.requestId" :title="t('attention.context')">
      <p class="attention-context">{{ item.detail }}</p>
    </UiDisclosure>
    <fieldset :disabled="busy || refreshing" class="attention-choices">
      <legend>{{ t('attention.chooseReply') }}</legend>
      <label v-for="choice in choices" :key="choice.id" class="attention-choice" :class="{ 'is-selected': modelValue.choice === choice.id }">
        <input type="radio" :name="`reply-${item.requestId}`" :value="choice.id" :checked="modelValue.choice === choice.id" @change="update({ choice: choice.id })" />
        <span>{{ choice.label }}</span>
      </label>
      <label class="attention-choice" :class="{ 'is-selected': modelValue.choice === 'other' }">
        <input type="radio" :name="`reply-${item.requestId}`" value="other" :checked="modelValue.choice === 'other'" @change="update({ choice: 'other' })" />
        <span>{{ t('attention.other') }}</span>
      </label>
    </fieldset>
    <div class="attention-input">
      <label :for="`attention-${item.requestId}`">{{ modelValue.choice === 'other' ? t('attention.response') : t('attention.note') }}</label>
      <textarea :id="`attention-${item.requestId}`" :value="modelValue.text" rows="3" maxlength="4096" :required="modelValue.choice === 'other'" :disabled="busy || refreshing" :placeholder="t('attention.placeholder')" @input="update({ text: ($event.target as HTMLTextAreaElement).value, choice: modelValue.choice || 'other' })" />
    </div>
    <p v-if="error" role="alert" class="inline-error attention-response-error">{{ error }}</p>
    <p v-if="response.length > 4096" role="alert" class="inline-error">{{ t('attention.tooLong') }}</p>
    <div class="attention-submit">
      <p>{{ t('attention.replyHint') }}</p>
      <button type="submit" class="primary-action" :disabled="busy || refreshing || !response || response.length > 4096">
        <GrowthLoading v-if="busy" variant="inline" :label="t('attention.sending')" />
        <span v-else>{{ t('attention.send') }}</span>
      </button>
    </div>
  </form>
</template>

<style scoped>
.attention-reply { display: grid; gap: 20px; min-width: 0; }
.attention-question h3 { margin: 0 0 12px; font-size: 22px; line-height: 1.4; letter-spacing: -.025em; }
.attention-question p, .attention-context { margin: 0; font-size: 14px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.attention-context { color: var(--color-muted); }
.attention-reply .ui-disclosure { padding-block: 12px; border-bottom: 1px solid var(--color-border); }
.attention-choices { display: grid; gap: 8px; min-width: 0; padding: 0; margin: 0; border: 0; }
.attention-choices legend { padding: 0 0 10px; font-size: 13px; font-weight: 600; }
.attention-choice { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); font-size: 14px; line-height: 1.5; cursor: pointer; overflow-wrap: anywhere; }
.attention-choice:hover { background: var(--color-surface-hover); }
.attention-choice.is-selected { border-color: var(--color-accent); background: var(--color-accent-soft); }
.attention-choice input { width: 16px; height: 16px; margin: 3px 0 0; flex: 0 0 auto; }
.attention-input { display: grid; gap: 8px; }
.attention-input label { font-size: 13px; color: var(--color-muted); }
.attention-input textarea { width: 100%; box-sizing: border-box; }
.attention-submit { display: flex; gap: 16px; justify-content: space-between; align-items: center; border-top: 1px solid var(--color-border); padding-top: 16px; }
.attention-submit p { max-width: 270px; margin: 0; color: var(--color-muted); font-size: 12px; line-height: 1.6; }
.attention-submit button { flex: 0 0 auto; }
.attention-response-error { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .attention-question h3 { font-size: 19px; }
  .attention-input textarea { font-size: 16px; }
  .attention-submit { align-items: stretch; flex-direction: column; gap: 12px; }
  .attention-submit p { max-width: none; }
}
</style>
