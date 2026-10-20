<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n'
import AttentionReply from './AttentionReply.vue'
import type { AttentionAnswer, AttentionReplyDraft } from './attention-replies'
import { attentionTaskHref, type AgentAttention } from './attention-store'

// The quick look at one request: what the Agent asks and the reply form. It
// renders inside the inbox's Dialog, so the request's title names the dialog.
// The draft lives in the attention store, so closing never loses it.
defineProps<{
  item?: AgentAttention
  /** The queue is still being read, so a linked request may yet appear. */
  loading: boolean
  agentName: string
  projectName: string
  draft: AttentionReplyDraft
  busy: boolean
  refreshing: boolean
  error: string
}>()
const emit = defineEmits<{ 'update:draft': [value: AttentionReplyDraft]; submit: [answer: AttentionAnswer] }>()
</script>

<template>
  <template v-if="!item">
    <DialogHeader>
      <DialogTitle>{{ t('attention.request') }}</DialogTitle>
      <DialogDescription :class="{ 'sr-only': loading }">{{ t(loading ? 'attention.loading' : 'attention.requestGone') }}</DialogDescription>
    </DialogHeader>
    <GrowthLoading v-if="loading" variant="compact" :label="t('attention.loading')" />
  </template>
  <template v-else>
    <DialogHeader>
      <DialogTitle class="text-xl leading-tight [overflow-wrap:anywhere]">{{ item.title }}</DialogTitle>
      <DialogDescription class="flex min-w-0 flex-wrap items-center gap-2">
        <span class="min-w-0 [overflow-wrap:anywhere]">{{ agentName }} · {{ projectName }}</span>
        <Badge variant="secondary" :title="t(`attention.kinds.${item.kind}`)">{{ t(`attention.kinds.${item.kind}`) }}</Badge>
      </DialogDescription>
    </DialogHeader>
    <AttentionReply :model-value="draft" :item="item" :busy="busy" :refreshing="refreshing" :error="error"
      @update:model-value="emit('update:draft', $event)" @submit="emit('submit', $event)" />
    <a v-if="item.taskId && !busy" class="attention-task-link" :href="attentionTaskHref(item)">{{ t('attention.task') }} ↗</a>
  </template>
</template>
