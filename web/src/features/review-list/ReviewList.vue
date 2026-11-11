<script setup lang="ts">
import AgentAvatar from '@/features/agent-profile/AgentAvatar.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { itemEditPath } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import UiDialog from '@/ui/UiDialog.vue'
import UiIconButton from '@/ui/UiIconButton.vue'
import UiNotice from '@/ui/UiNotice.vue'

import { guessedAction, oneLine, rowChoices, type ReviewLine, type RowChoice } from './review-list'
import ReviewRows from './ReviewRows.vue'
import TonborgExplain from './TonborgExplain.vue'
import { useReviewList } from './review-store'

// The knowledge part of 待决策 (rec#96): earlier Agent replies kept by mistake
// (11-08, dropped together), Tonborg's questions, every pending item, and what
// Tonborg confirmed for the person. Each line is one item in
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

// Coming back to the page reads what Tonborg decided meanwhile.
const onVisible = () => { if (document.visibilityState === 'visible') void review.refreshIfTonborgMoved() }
onMounted(() => document.addEventListener('visibilitychange', onVisible))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible))

const projectNames = computed(() => new Map(props.projects.map(project => [project.project_id, project.profile.name])))
const projectName = (line: ReviewLine) => line.projectId
  ? projectNames.value.get(line.projectId) ?? line.projectId : t('reviewList.everywhere')
const meta = (line: ReviewLine) => [projectName(line), line.proposer, line.reason ? t(`reviewList.reasons.${line.reason}`) : '']
  .filter(Boolean).join(' · ')
// What Tonborg asks stands apart (Jevons 11-06: 「长得都一样，看不出来」): its own lifted
// glass card first, its avatar and name. Each line is ONE plain question that
// quotes the item (Jevons 11-07: 「内容是什么呀？」; 11-11: 「说人话，说重点，能点
// 一下是否就不要让他自己输」): what FULI is about to do and why Tonborg is
// unsure. Its guess is the filled first button, the opposite the second, and
// 其他 opens a short field for the person's own words. Tonborg's reason is in 查看详情.
const REASON_LIMIT = 60
const askedMeta = (line: ReviewLine) => [projectName(line), line.proposer].filter(Boolean).join(' · ')
const askText = (line: ReviewLine) => line.review?.ask ?? line.text
const choicesOf = (line: ReviewLine) => line.review ? rowChoices(line.review) : null
const tonborgReason = (line: ReviewLine) => line.review?.summary ? oneLine(line.review.summary, REASON_LIMIT) : ''
const busy = (key: string) => review.pending[key]
const pendingLabel = (key: string) => t(`reviewList.pending.${busy(key) ?? 'confirm'}`)
// A whole group's progress counts the requests that came back, never invented stages.
const progressLabel = (group: 'pending' | 'questions') => t(`reviewList.pending.${group === 'pending' ? 'all' : 'guesses'}`,
  review.progress[group] ?? { done: 0, total: review.list[group].length })
// 全部丢掉 counts the batches that came back; 撤销 names how many go back.
const echoesLabel = () => busy('echoes') === 'undo' ? t('reviewList.pending.restore', { count: review.restoring })
  : t('reviewList.pending.echoes', review.progress.echoes ?? { done: 0, total: review.list.echoes.length })
const editableQuestions = computed(() => review.list.questions.some(line => {
  const action = guessedAction(line.review?.guess ?? null)
  return action === 'confirm' || action === 'drop'
}))

function edit(line: ReviewLine) {
  if (!line.item) return
  void review.edit(line)
  void router.push(itemEditPath(props.personalSpaceId, { item_kind: line.item.itemKind, item_id: line.item.id }))
}
// One click answers a question: keep or drop at once, 改一下 on the item's own page.
function answer(line: ReviewLine, choice: RowChoice) {
  if (choice.action === 'edit') edit(line)
  else void review.act(line, choice.action)
}

// 其他: the question again, a short field for the person's own words, and the one way to answer the row does not show.
const otherLine = ref<ReviewLine | null>(null)
const otherWords = ref('')
const otherRest = computed(() => otherLine.value ? choicesOf(otherLine.value)?.rest ?? null : null)
function openOther(line: ReviewLine) { otherWords.value = ''; otherLine.value = line }
async function sendOther() {
  const line = otherLine.value
  const words = otherWords.value.trim()
  if (!line || !words) return
  if (await review.other(line, words)) otherLine.value = null
}
function answerRest() {
  const line = otherLine.value
  const rest = otherRest.value
  otherLine.value = null
  if (line && rest) answer(line, rest)
}
</script>

<template>
  <div class="review-list" data-review-list>
    <GrowthLoading v-if="!review.loaded && review.loading" variant="page" :label="t('reviewList.loading')" />
    <UiNotice v-if="review.error" tone="error">{{ t('reviewList.loadError') }}
      <template #actions><Button variant="outline" size="sm" :disabled="review.loading" @click="review.refresh()">{{ t('attention.refresh') }}</Button></template>
    </UiNotice>

    <Card v-if="review.list.echoes.length || busy('echoes')" as="section" class="review-group" aria-labelledby="review-echoes-title" data-review-group="echoes">
      <CardHeader class="review-group__header">
        <CardTitle id="review-echoes-title" as="h2" class="review-group__title" :title="t('reviewList.echoesHint')"
          :data-outline-label="t('reviewList.groups.echoes')" :data-outline-count="review.list.echoes.length">{{ t('reviewList.groups.echoes') }} · {{ review.list.echoes.length }}</CardTitle>
        <CardAction class="review-group__action">
          <span class="review-busy review-busy--progress"><GrowthLoading v-if="busy('echoes')" variant="inline" :label="echoesLabel()" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy('echoes')) || !review.list.echoes.length" data-review-drop-echoes
            @click="review.dropEchoes()">{{ t('reviewList.actions.dropAll') }}</Button>
        </CardAction>
      </CardHeader>
      <ReviewRows v-if="review.list.echoes.length" v-slot="{ line }" :lines="review.list.echoes" :label="t('reviewList.groups.echoes')">
        <span class="review-row__body">
          <span class="review-row__meta">{{ meta(line) }}</span>
          <span class="review-row__text" :title="line.text">{{ line.text }}</span>
        </span>
        <span class="review-row__actions">
          <span class="review-busy"><GrowthLoading v-if="busy(line.key)" variant="inline" :label="pendingLabel(line.key)" /></span>
          <Button size="sm" variant="ghost" :disabled="Boolean(busy(line.key) || busy('echoes'))" @click="review.act(line, 'confirm')">{{ t('reviewList.actions.confirm') }}</Button>
          <Button size="sm" variant="ghost" :disabled="Boolean(busy(line.key) || busy('echoes'))" @click="review.act(line, 'drop')">{{ t('reviewList.actions.drop') }}</Button>
          <UiIconButton icon="info" size="sm" :label="t('reviewList.actions.details')" @click="detail = line" />
        </span>
      </ReviewRows>
    </Card>

    <Card v-if="review.list.questions.length" as="section" class="review-group review-group--asks" aria-labelledby="review-questions-title" data-review-group="questions">
      <CardHeader class="review-group__header">
        <CardTitle id="review-questions-title" as="h2" class="review-group__title review-group__title--asks"
          :data-outline-label="t('reviewList.groups.questions')" :data-outline-count="review.list.questions.length">
          <AgentAvatar class="review-group__avatar" agent-id="tonborg" />
          <span class="review-group__name" :title="t('reviewList.groups.questions')">{{ t('reviewList.groups.questions') }}</span>
          <span class="review-group__count">· {{ review.list.questions.length }}</span>
          <TonborgExplain :count="review.list.questions.length" />
        </CardTitle>
        <CardAction v-if="editableQuestions" class="review-group__action">
          <span class="review-busy review-busy--progress"><GrowthLoading v-if="busy('questions')" variant="inline" :label="progressLabel('questions')" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy('questions'))" @click="review.actAll('questions')">{{ t('reviewList.actions.acceptGuesses') }}</Button>
        </CardAction>
      </CardHeader>
      <ReviewRows v-slot="{ line }" :lines="review.list.questions" :label="t('reviewList.groups.questions')">
        <span class="review-row__body">
          <span class="review-row__meta">{{ askedMeta(line) }}</span>
          <span class="review-row__text" :title="line.text" data-review-ask>{{ askText(line) }}</span>
        </span>
        <span class="review-row__actions">
          <span class="review-busy"><GrowthLoading v-if="busy(line.key)" variant="inline" :label="pendingLabel(line.key)" /></span>
          <Button v-for="choice in choicesOf(line)?.choices" :key="choice.answer" size="sm" :variant="choice.guessed ? 'default' : 'outline'"
            :disabled="Boolean(busy(line.key) || busy('questions'))" :data-review-answer="choice.answer" @click="answer(line, choice)">{{ t(`reviewList.answers.${choice.label}`) }}</Button>
          <Button size="sm" variant="ghost" :disabled="Boolean(busy(line.key) || busy('questions'))" data-review-other @click="openOther(line)">{{ t('reviewList.answers.other') }}</Button>
          <UiIconButton icon="info" size="sm" :label="t('reviewList.actions.details')" @click="detail = line" />
        </span>
      </ReviewRows>
    </Card>

    <Card v-if="review.list.pending.length" as="section" class="review-group" aria-labelledby="review-pending-title" data-review-group="pending">
      <CardHeader class="review-group__header">
        <CardTitle id="review-pending-title" as="h2" class="review-group__title"
          :data-outline-label="t('reviewList.groups.pending')" :data-outline-count="review.list.pending.length">{{ t('reviewList.groups.pending') }} · {{ review.list.pending.length }}</CardTitle>
        <CardAction class="review-group__action">
          <span class="review-busy review-busy--progress"><GrowthLoading v-if="busy('pending')" variant="inline" :label="progressLabel('pending')" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy('pending'))" @click="review.actAll('pending')">{{ t('reviewList.actions.confirmAll') }}</Button>
        </CardAction>
      </CardHeader>
      <ReviewRows v-slot="{ line }" :lines="review.list.pending" :label="t('reviewList.groups.pending')">
        <span class="review-row__body">
          <span class="review-row__meta">{{ meta(line) }}</span>
          <span class="review-row__text" :title="line.text">{{ line.text }}</span>
        </span>
        <span class="review-row__actions">
          <span class="review-busy"><GrowthLoading v-if="busy(line.key)" variant="inline" :label="pendingLabel(line.key)" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy(line.key) || busy('pending'))" @click="review.act(line, 'confirm')">{{ t('reviewList.actions.confirm') }}</Button>
          <Button size="sm" variant="ghost" :disabled="Boolean(busy(line.key) || busy('pending'))" @click="review.act(line, 'drop')">{{ t('reviewList.actions.drop') }}</Button>
          <Button size="sm" variant="ghost" :disabled="Boolean(busy(line.key) || busy('pending'))" @click="edit(line)">{{ t('reviewList.actions.edit') }}</Button>
          <UiIconButton icon="info" size="sm" :label="t('reviewList.actions.details')" @click="detail = line" />
        </span>
      </ReviewRows>
    </Card>

    <slot />

    <Card v-if="review.list.confirmed.length" as="section" class="review-group" aria-labelledby="review-confirmed-title" data-review-group="confirmed">
      <CardHeader class="review-group__header">
        <CardTitle id="review-confirmed-title" as="h2" class="review-group__title"
          :data-outline-label="t('reviewList.groups.confirmed')" :data-outline-count="review.list.confirmed.length">{{ t('reviewList.groups.confirmed') }} · {{ review.list.confirmed.length }}</CardTitle>
        <CardAction class="review-group__action">
          <span class="review-busy"><GrowthLoading v-if="busy('confirmed')" variant="inline" :label="t('reviewList.pending.ack')" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy('confirmed'))" @click="review.acknowledgeConfirmed()">{{ t('reviewList.actions.allRight') }}</Button>
        </CardAction>
      </CardHeader>
      <ReviewRows v-slot="{ line }" :lines="review.list.confirmed" :label="t('reviewList.groups.confirmed')">
        <span class="review-row__body">
          <span class="review-row__meta" :title="line.review?.summary">{{ projectName(line) }} · {{ t('reviewList.byTonborg') }}<template v-if="tonborgReason(line)"> · {{ tonborgReason(line) }}</template></span>
          <span class="review-row__text" :title="line.text">{{ line.text }}</span>
        </span>
        <span class="review-row__actions">
          <span class="review-busy"><GrowthLoading v-if="busy(line.key)" variant="inline" :label="pendingLabel(line.key)" /></span>
          <Button size="sm" variant="outline" :disabled="Boolean(busy(line.key))" @click="review.undo(line)">{{ t('reviewList.actions.undo') }}</Button>
          <UiIconButton icon="info" size="sm" :label="t('reviewList.actions.details')" @click="detail = line" />
        </span>
      </ReviewRows>
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
          <template v-if="detail.review.ask"><dt>{{ t('reviewList.details.ask') }}</dt><dd>{{ detail.review.ask }}</dd></template>
        </template>
      </dl>
    </UiDialog>

    <UiDialog :open="Boolean(otherLine)" :title="t('reviewList.other.title')" :description="otherLine ? askText(otherLine) : undefined"
      size="sm" form :busy="Boolean(otherLine && busy(otherLine.key))" data-review-other-dialog @close="otherLine = null" @submit="sendOther">
      <Field>
        <FieldLabel for="review-other-words">{{ t('reviewList.other.label') }}</FieldLabel>
        <Textarea id="review-other-words" v-model="otherWords" rows="3" maxlength="600" autofocus />
      </Field>
      <template #footer>
        <Button v-if="otherRest" type="button" variant="ghost" data-review-other-rest @click="answerRest">{{ t(`reviewList.answers.${otherRest.label}`) }}</Button>
        <Button type="submit" :disabled="!otherWords.trim()" :loading="Boolean(otherLine && busy(otherLine.key))"
          :loading-label="t('reviewList.pending.other')">{{ t('reviewList.other.submit') }}</Button>
      </template>
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
