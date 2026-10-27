<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n'
import AttentionReply from './AttentionReply.vue'
import TaskBlockerNotice from './TaskBlockerNotice.vue'
import type { AttentionAnswer, AttentionReplyDraft } from './attention-replies'
import { attentionTaskHref, type AgentAttention, type AttentionPeekState } from './attention-store'

// The quick look at one request: what the Agent asks and the reply form. It
// renders inside the inbox's Dialog, so the request's title names the dialog.
// The draft lives in the attention store, so closing never loses it.
defineProps<{
  item?: AgentAttention
  state: AttentionPeekState
  agentName: string
  projectName: string
  draft: AttentionReplyDraft
  busy: boolean
  refreshing: boolean
  error: string
}>()
const emit = defineEmits<{ 'update:draft': [value: AttentionReplyDraft]; submit: [answer: AttentionAnswer]; retry: [] }>()
</script>

<template>
  <template v-if="!item">
    <DialogHeader>
      <DialogTitle>{{ t('attention.request') }}</DialogTitle>
      <DialogDescription :class="{ 'sr-only': state === 'loading' }">
        {{ t(state === 'loading' ? 'attention.loadingRequest' : state === 'failed' ? 'attention.requestLoadError' : 'attention.requestMissing') }}
      </DialogDescription>
    </DialogHeader>
    <GrowthLoading v-if="state === 'loading'" variant="compact" :label="t('attention.loadingRequest')" />
    <Button v-else-if="state === 'failed'" class="justify-self-start" variant="outline" size="sm" @click="emit('retry')">{{ t('common.actions.retry') }}</Button>
  </template>
  <template v-else>
    <DialogHeader>
      <DialogTitle class="text-xl leading-tight [overflow-wrap:anywhere]">{{ item.title }}</DialogTitle>
      <DialogDescription class="flex min-w-0 flex-wrap items-center gap-2">
        <span class="min-w-0 [overflow-wrap:anywhere]">{{ agentName }} · {{ projectName }}</span>
        <Badge variant="secondary" :title="t(`attention.kinds.${item.kind}`)">{{ t(`attention.kinds.${item.kind}`) }}</Badge>
        <a v-if="item.taskId && !busy" class="attention-task-link ml-auto" :href="attentionTaskHref(item)">{{ t('attention.task') }} ↗</a>
      </DialogDescription>
    </DialogHeader>
    <TaskBlockerNotice v-if="item.taskBlocker" :blocker="item.taskBlocker" />
    <AttentionReply v-if="state === 'open'" :model-value="draft" :item="item" :busy="busy" :refreshing="refreshing" :error="error"
      @update:model-value="emit('update:draft', $event)" @submit="emit('submit', $event)" />
    <p v-else class="attention-handled" role="status">{{ t('attention.requestHandled') }}</p>
  </template>
</template>
