<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { itemEditPath } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import UiDialog from '@/ui/UiDialog.vue'
import UiIconButton from '@/ui/UiIconButton.vue'
import UiNotice from '@/ui/UiNotice.vue'

import { guessedAction, type ReviewAction, type ReviewLine } from './review-list'
import { useReviewList } from './review-store'

// The knowledge part of 待决策 (rec#96): Tonborg's questions, every pending
// item, and what Tonborg confirmed for the person. Each line is one item in
// plain words with the same actions in the same places; the whole text,
// source and Tonborg's reason are in 查看详情. A group with nothing in it is
// not shown at all.
const props = defineProps<{ personalSpaceId: string; projects: PersonalProject[] }>()
const review = useReviewList()
const router = useRouter()
const detail = ref<ReviewLine | null>(null)

watch(() => props.personalSpaceId, (id) => {
  review.setSpace(id)
  if (id && review.loaded) void review.refresh()
}, { immediate: true })

const projectNames = computed(() => new Map(props.projects.map(project => [project.project_id, project.profile.name])))
const projectName = (line: ReviewLine) => line.projectId
  ? projectNames.value.get(line.projectId) ?? line.projectId : t('reviewList.everywhere')
const meta = (line: ReviewLine) => [projectName(line), line.proposer, line.reason ? t(`reviewList.reasons.${line.reason}`) : '']
  .filter(Boolean).join(' · ')
const busy = (key: string) => review.pending[key]
const pendingLabel = (key: string) => t(`reviewList.pending.${busy(key) ?? 'confirm'}`)
const editableQuestions = computed(() => review.list.questions.some(line => {
  const action = guessedAction(line.review?.guess ?? null)
  return action === 'confirm' || action === 'drop'
}))

function edit(line: ReviewLine) {
  if (!line.item) return
  void review.edit(line)
  void router.push(itemEditPath(props.personalSpaceId, { item_kind: line.item.itemKind, item_id: line.item.id }))
}
// The action Tonborg guessed is the one filled button; the others keep their places and the list's quiet look.
const variant = (line: ReviewLine, action: ReviewAction) =>
  guessedAction(line.review?.guess ?? null) === action ? 'default' : action === 'confirm' ? 'outline' : 'ghost'
</script>

<template>
  <div class="review-list" data-review-list>
    <GrowthLoading v-if="!review.loaded && review.loading" variant="page" :label="t('reviewList.loading')" />
    <UiNotice v-if="review.error" tone="error">{{ t('reviewList.loadError') }}
      <template #actions><Button variant="outline" size="sm" :disabled="review.loading" @click="review.refresh()">{{ t('attention.refresh') }}</Button></template>
    </UiNotice>

    <Card v-if="review.list.questions.length" as="section" class="review-group" aria-labelledby="review-questions-title" data-review-group="questions">
      <CardHeader class="review-group__header">
        <CardTitle id="review-questions-title" as="h2" class="review-group__title">{{ t('reviewList.groups.questions') }} · {{ review.list.questions.length }}</CardTitle>
        <CardAction v-if="editableQuestions" class="review-group__action">
          <span class="review-busy"><GrowthLoading v-if="busy('questions')" variant="inline" :label="t('reviewList.pending.guesses')" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy('questions'))" @click="review.actAll('questions')">{{ t('reviewList.actions.acceptGuesses') }}</Button>
        </CardAction>
      </CardHeader>
      <ul class="review-rows">
        <li v-for="line in review.list.questions" :key="line.key" class="review-row" :data-review-line="line.key">
          <span class="review-row__text" :title="line.review?.question ?? line.text">{{ line.review?.question ?? line.text }}</span>
          <span class="review-row__meta">{{ meta(line) }}</span>
          <span class="review-row__actions">
            <span class="review-busy"><GrowthLoading v-if="busy(line.key)" variant="inline" :label="pendingLabel(line.key)" /></span>
            <Button size="sm" :variant="variant(line, 'confirm')" :disabled="Boolean(busy(line.key))" @click="review.act(line, 'confirm')">{{ t('reviewList.actions.confirm') }}</Button>
            <Button size="sm" :variant="variant(line, 'drop')" :disabled="Boolean(busy(line.key))" @click="review.act(line, 'drop')">{{ t('reviewList.actions.drop') }}</Button>
            <Button size="sm" :variant="variant(line, 'edit')" :disabled="Boolean(busy(line.key))" @click="edit(line)">{{ t('reviewList.actions.edit') }}</Button>
            <UiIconButton icon="info" size="sm" :label="t('reviewList.actions.details')" @click="detail = line" />
          </span>
        </li>
      </ul>
    </Card>

    <Card v-if="review.list.pending.length" as="section" class="review-group" aria-labelledby="review-pending-title" data-review-group="pending">
      <CardHeader class="review-group__header">
        <CardTitle id="review-pending-title" as="h2" class="review-group__title">{{ t('reviewList.groups.pending') }} · {{ review.list.pending.length }}</CardTitle>
        <CardAction class="review-group__action">
          <span class="review-busy"><GrowthLoading v-if="busy('pending')" variant="inline" :label="t('reviewList.pending.all')" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy('pending'))" @click="review.actAll('pending')">{{ t('reviewList.actions.confirmAll') }}</Button>
        </CardAction>
      </CardHeader>
      <ul class="review-rows">
        <li v-for="line in review.list.pending" :key="line.key" class="review-row" :data-review-line="line.key">
          <span class="review-row__text" :title="line.text">{{ line.text }}</span>
          <span class="review-row__meta">{{ meta(line) }}</span>
          <span class="review-row__actions">
            <span class="review-busy"><GrowthLoading v-if="busy(line.key)" variant="inline" :label="pendingLabel(line.key)" /></span>
            <Button size="sm" variant="outline" :disabled="Boolean(busy(line.key))" @click="review.act(line, 'confirm')">{{ t('reviewList.actions.confirm') }}</Button>
            <Button size="sm" variant="ghost" :disabled="Boolean(busy(line.key))" @click="review.act(line, 'drop')">{{ t('reviewList.actions.drop') }}</Button>
            <Button size="sm" variant="ghost" :disabled="Boolean(busy(line.key))" @click="edit(line)">{{ t('reviewList.actions.edit') }}</Button>
            <UiIconButton icon="info" size="sm" :label="t('reviewList.actions.details')" @click="detail = line" />
          </span>
        </li>
      </ul>
    </Card>

    <slot />

    <Card v-if="review.list.confirmed.length" as="section" class="review-group" aria-labelledby="review-confirmed-title" data-review-group="confirmed">
      <CardHeader class="review-group__header">
        <CardTitle id="review-confirmed-title" as="h2" class="review-group__title">{{ t('reviewList.groups.confirmed') }} · {{ review.list.confirmed.length }}</CardTitle>
        <CardAction class="review-group__action">
          <span class="review-busy"><GrowthLoading v-if="busy('confirmed')" variant="inline" :label="t('reviewList.pending.ack')" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy('confirmed'))" @click="review.acknowledgeConfirmed()">{{ t('reviewList.actions.allRight') }}</Button>
        </CardAction>
      </CardHeader>
      <ul class="review-rows">
        <li v-for="line in review.list.confirmed" :key="line.key" class="review-row" :data-review-line="line.key">
          <span class="review-row__text" :title="line.text">{{ line.text }}</span>
          <span class="review-row__meta">{{ projectName(line) }} · {{ t('reviewList.byTonborg') }}</span>
          <span class="review-row__actions">
            <span class="review-busy"><GrowthLoading v-if="busy(line.key)" variant="inline" :label="pendingLabel(line.key)" /></span>
            <Button size="sm" variant="outline" :disabled="Boolean(busy(line.key))" @click="review.undo(line)">{{ t('reviewList.actions.undo') }}</Button>
            <UiIconButton icon="info" size="sm" :label="t('reviewList.actions.details')" @click="detail = line" />
          </span>
        </li>
      </ul>
    </Card>

    <UiDialog :open="Boolean(detail)" :title="t('reviewList.details.title')" size="md" @close="detail = null">
      <dl v-if="detail" class="review-detail">
        <dt>{{ t('reviewList.details.content') }}</dt>
        <dd class="ui-prose">{{ detail.item ? detail.item.body || detail.item.title : detail.text }}</dd>
        <dt>{{ t('reviewList.details.project') }}</dt><dd>{{ projectName(detail) }}</dd>
        <dt>{{ t('reviewList.details.proposer') }}</dt><dd>{{ detail.proposer }}</dd>
        <template v-if="detail.reason"><dt>{{ t('reviewList.details.reason') }}</dt><dd>{{ t(`reviewList.reasons.${detail.reason}`) }}</dd></template>
        <template v-if="detail.review">
          <dt>{{ t('reviewList.details.tonborg') }}</dt><dd class="ui-prose">{{ detail.review.summary }}</dd>
          <template v-if="detail.review.question"><dt>{{ t('reviewList.details.guess') }}</dt><dd>{{ detail.review.question }}</dd></template>
        </template>
      </dl>
    </UiDialog>
  </div>
</template>

<style src="./review-rows.css"></style>
<style scoped>
.review-list { display: contents; }
.review-detail { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0; }
.review-detail dt { color: var(--color-muted); font-size: var(--text-meta); }
.review-detail dd { margin: 0; color: var(--color-ink); font-size: var(--text-body); overflow-wrap: anywhere; }
</style>
