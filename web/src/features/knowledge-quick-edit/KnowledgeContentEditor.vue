<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { t } from '@/i18n'
import {
  contentRequest, deactivateRequest, editFailure,
  type EditFailure, type KnowledgeItemSummary,
} from './model'
import { reviseItem } from './quick-edit-api'

// Correct the item's words or stop using it. Both keep the same item, its
// source and history; each names the version the page read.
const props = defineProps<{ item: KnowledgeItemSummary; spaceId: string }>()
const emit = defineEmits<{ saved: []; failed: [reason: EditFailure] }>()

const content = ref(props.item.content)
const reason = ref('')
const stopReason = ref('')
const pending = ref<'content' | 'deactivate' | null>(null)
const message = ref<{ kind: 'error' | 'status'; text: string } | null>(null)
watch(() => props.item.version, () => { content.value = props.item.content })

const unchanged = computed(() => content.value.trim() === props.item.content.trim())
const contentBody = computed(() => unchanged.value ? null : contentRequest(props.spaceId, props.item, content.value, reason.value))
const stopBody = computed(() => deactivateRequest(props.spaceId, props.item, stopReason.value))

async function submit(kind: 'content' | 'deactivate', body: object | null, done: string) {
  if (!body) return
  pending.value = kind
  message.value = null
  try {
    await reviseItem(props.item, body)
    reason.value = ''
    stopReason.value = ''
    message.value = { kind: 'status', text: done }
    emit('saved')
  } catch (error) {
    const failure = editFailure(error)
    message.value = { kind: 'error', text: failure === 'forbidden' ? t('knowledgeQuickEdit.forbidden')
      : failure === 'conflict' ? t('knowledgeQuickEdit.conflict') : String((error as Error).message) }
    emit('failed', failure)
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <Card as="section" data-content-editor>
    <CardHeader><CardTitle as="h2">{{ t('knowledgeQuickEdit.content.title') }}</CardTitle></CardHeader>
    <form class="grid gap-4 px-5"
      @submit.prevent="submit('content', contentBody, t('knowledgeQuickEdit.content.saved'))">
      <Field>
        <FieldLabel for="item-content">{{ t('knowledgeQuickEdit.content.label') }}</FieldLabel>
        <Textarea id="item-content" v-model="content" rows="3" maxlength="4096" :disabled="pending !== null" />
        <FieldDescription v-if="unchanged">{{ t('knowledgeQuickEdit.content.unchanged') }}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel for="content-reason">{{ t('knowledgeQuickEdit.content.reason') }}</FieldLabel>
        <Input id="content-reason" v-model="reason" maxlength="2000" autocomplete="off" :disabled="pending !== null" />
      </Field>
      <div>
        <Button type="submit" :disabled="!contentBody" :loading="pending === 'content'"
          :loading-label="t('knowledgeQuickEdit.content.saving')">{{ t('knowledgeQuickEdit.content.save') }}</Button>
      </div>
    </form>
  </Card>
  <Card as="section" data-deactivate>
    <CardHeader>
      <CardTitle as="h2">{{ t('knowledgeQuickEdit.deactivate.title') }}</CardTitle>
      <CardDescription>{{ t('knowledgeQuickEdit.deactivate.help') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5"
      @submit.prevent="submit('deactivate', stopBody, t('knowledgeQuickEdit.deactivate.done'))">
      <Field>
        <FieldLabel for="stop-reason">{{ t('knowledgeQuickEdit.deactivate.reason') }}</FieldLabel>
        <Input id="stop-reason" v-model="stopReason" maxlength="2000" autocomplete="off" :disabled="pending !== null" />
      </Field>
      <div>
        <Button type="submit" variant="destructive" :disabled="!stopBody" :loading="pending === 'deactivate'"
          :loading-label="t('knowledgeQuickEdit.deactivate.running')">{{ t('knowledgeQuickEdit.deactivate.action') }}</Button>
      </div>
    </form>
  </Card>
  <p v-if="message" :role="message.kind === 'status' ? 'status' : 'alert'" class="m-0 text-sm"
    :class="message.kind === 'status' ? 'text-success' : 'text-destructive'" data-content-message>{{ message.text }}</p>
</template>
