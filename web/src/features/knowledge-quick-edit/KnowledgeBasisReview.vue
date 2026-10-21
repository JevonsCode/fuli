<script setup lang="ts">
import { computed, ref } from 'vue'

import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import {
  editFailure, meaningChangedRequest, reaffirmRequest, versionStatus,
  type EditFailure, type KnowledgeItemView,
} from './model'
import { reviseItem } from './quick-edit-api'

// D-20.7, both sides of a basis: a conclusion whose basis changed waits for
// the person's review ("仍然成立" writes a new version on the new basis), and
// a basis with conclusions lets the person say later that an edit did change
// its meaning. Only a person does either; each names the version the page read.
const props = defineProps<{ item: KnowledgeItemView; spaceId: string }>()
const emit = defineEmits<{ saved: []; versioned: [itemId: string, waiting: number]; failed: [reason: EditFailure] }>()

const reviewReason = ref('')
const meaningReason = ref('')
const pending = ref<'review' | 'meaning' | null>(null)
const message = ref<{ kind: 'error' | 'status'; text: string } | null>(null)

const review = computed(() => versionStatus(props.item) === 'current' ? props.item.basis_review ?? null : null)
const dependents = computed(() => props.item.dependent_count ?? 0)
const reviewBody = computed(() => reaffirmRequest(props.spaceId, props.item, reviewReason.value))
const meaningBody = computed(() => meaningChangedRequest(props.spaceId, props.item, meaningReason.value))

async function submit(kind: 'review' | 'meaning', body: object | null) {
  if (!body) return
  pending.value = kind
  message.value = null
  try {
    const result = await reviseItem(props.item, body)
    reviewReason.value = ''
    meaningReason.value = ''
    if (kind === 'review' && result.version_item_id) {
      emit('versioned', result.version_item_id, 0)
      return
    }
    message.value = { kind: 'status', text: t('knowledgeQuickEdit.dependents.done', { count: result.dependents_changed ?? 0 }) }
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
  <Card v-if="review" as="section" :data-basis-review-card="review">
    <CardHeader>
      <CardTitle as="h2">{{ t('knowledgeQuickEdit.basisReview.title') }}</CardTitle>
      <CardDescription>{{ t(`knowledgeQuickEdit.basisReview.${review}Note`) }} {{ t('knowledgeQuickEdit.basisReview.help') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5" @submit.prevent="submit('review', reviewBody)">
      <Field>
        <FieldLabel for="review-reason">{{ t('knowledgeQuickEdit.basisReview.reason') }}</FieldLabel>
        <Input id="review-reason" v-model="reviewReason" maxlength="2000" autocomplete="off" :disabled="pending !== null" />
      </Field>
      <div>
        <Button type="submit" :disabled="!reviewBody" :loading="pending === 'review'"
          :loading-label="t('knowledgeQuickEdit.basisReview.running')">{{ t('knowledgeQuickEdit.basisReview.action') }}</Button>
      </div>
    </form>
  </Card>
  <Card v-if="dependents" as="section" data-item-dependents>
    <CardHeader>
      <CardTitle as="h2">{{ t('knowledgeQuickEdit.dependents.title') }}</CardTitle>
      <CardDescription>{{ t('knowledgeQuickEdit.dependents.count', { count: dependents }) }} {{ t('knowledgeQuickEdit.dependents.help') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5" @submit.prevent="submit('meaning', meaningBody)">
      <Field>
        <FieldLabel for="meaning-reason">{{ t('knowledgeQuickEdit.dependents.reason') }}</FieldLabel>
        <Input id="meaning-reason" v-model="meaningReason" maxlength="2000" autocomplete="off" :disabled="pending !== null" />
      </Field>
      <div>
        <Button type="submit" variant="outline" :disabled="!meaningBody" :loading="pending === 'meaning'"
          :loading-label="t('knowledgeQuickEdit.dependents.running')">{{ t('knowledgeQuickEdit.dependents.action') }}</Button>
      </div>
    </form>
  </Card>
  <p v-if="message" :role="message.kind === 'status' ? 'status' : 'alert'" class="m-0 text-sm"
    :class="message.kind === 'status' ? 'text-success' : 'text-destructive'" data-review-message>{{ message.text }}</p>
</template>
