<script setup lang="ts">
import { computed, ref } from 'vue'

import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { reaffirmRequest, versionStatus, type EditFailure, type KnowledgeItemView } from './model'
import { useRevisionAction } from './useRevisionAction'

// D-20.7: a conclusion whose basis changed waits for the person's review.
// "仍然成立" writes a new version resting on the new basis; otherwise the
// person edits it. Only a person reviews; it names the version the page read.
const props = defineProps<{ item: KnowledgeItemView; spaceId: string }>()
const emit = defineEmits<{ versioned: [itemId: string, waiting: number]; failed: [reason: EditFailure] }>()

const reason = ref('')
const review = computed(() => versionStatus(props.item) === 'current' ? props.item.basis_review ?? null : null)
const body = computed(() => reaffirmRequest(props.spaceId, props.item, reason.value))
const action = useRevisionAction(() => props.item, {
  done: (result) => {
    reason.value = ''
    if (result.version_item_id) emit('versioned', result.version_item_id, 0)
    return null
  },
  failed: (failure) => emit('failed', failure),
})
</script>

<template>
  <Card v-if="review" as="section" :data-basis-review-card="review">
    <CardHeader>
      <CardTitle as="h2">{{ t('knowledgeQuickEdit.basisReview.title') }}</CardTitle>
      <CardDescription>{{ t(`knowledgeQuickEdit.basisReview.${review}Note`) }} {{ t('knowledgeQuickEdit.basisReview.help') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5" @submit.prevent="action.submit(body)">
      <Field>
        <FieldLabel for="review-reason">{{ t('knowledgeQuickEdit.basisReview.reason') }}</FieldLabel>
        <Input id="review-reason" v-model="reason" maxlength="2000" autocomplete="off" :disabled="action.pending.value" />
      </Field>
      <div>
        <Button type="submit" :disabled="!body" :loading="action.pending.value"
          :loading-label="t('knowledgeQuickEdit.basisReview.running')">{{ t('knowledgeQuickEdit.basisReview.action') }}</Button>
      </div>
    </form>
    <p v-if="action.message.value" role="alert" class="m-0 px-5 text-sm text-destructive" data-review-message>
      {{ action.message.value.text }}
    </p>
  </Card>
</template>
