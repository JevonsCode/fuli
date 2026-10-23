<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { evidenceApplicationLabel, evidenceKindLabel, itemEditPath, versionStatusLabel, versionTone,
  type KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { confirmHardDelete, previewHardDelete, confirmSourceDelete, previewSourceDelete } from './hard-delete-api'
import SourceDeleteSelections from './SourceDeleteSelections.vue'
import { sourcePreviewDetails, sourceSelection, type SourceDeletePreview, type SourceDeleteSelection,
  type SourceDeleteTarget } from './source-delete-model'
import { confirmationMatches, deletedState, hardDeletedFrom, ledgerDamage, recordCounts, refusedByGraph, stalePreview,
  type HardDeletePreview, type HardDeletedState } from './model'

// rec#5 C9: the second step of a permanent delete. It lists exactly what goes,
// what stays and what rests on it, then asks the person to type 删除. The
// delete names this preview; if anything changed meanwhile the provider
// refuses it (409) and the dialog lists again from what is stored now.
const props = defineProps<{ item: KnowledgeItemSummary | SourceDeleteTarget; spaceId: string }>()
const emit = defineEmits<{ deleted: [state: HardDeletedState]; cancel: []; pending: [value: boolean] }>()

const rawPreview = ref<HardDeletePreview | SourceDeletePreview | null>(null)
const sourceTarget = computed(() => props.item.item_kind === 'episode' || props.item.item_kind === 'session'
  ? props.item as SourceDeleteTarget : null)
const sourcePreview = computed(() => rawPreview.value?.item_kind === 'episode' || rawPreview.value?.item_kind === 'session'
  ? rawPreview.value as SourceDeletePreview : null)
const preview = computed(() => sourcePreview.value ? sourcePreviewDetails(sourcePreview.value) : rawPreview.value as HardDeletePreview | null)
const selection = ref<SourceDeleteSelection>({ include: [], exclude: [] })
const previewValid = ref(false)
const loading = ref(false)
const reloading = ref(false)
const reloadCause = ref<'selection' | 'submission' | 'changed'>('changed')
const deleting = ref(false)
watch(deleting, value => emit('pending', value), { flush: 'sync' })
const typed = ref('')
const notice = ref('')
const error = ref('')
let request = 0

const ready = computed(() => previewValid.value && Boolean(preview.value) && !loading.value && !reloading.value
  && !preview.value?.drafts?.submitting && confirmationMatches(preview.value!, typed.value))
const records = computed(() => preview.value ? recordCounts(preview.value.counts) : [])
const publicProjects = computed(() => [...new Set((preview.value?.publications ?? [])
  .map(publication => publication.project_name || publication.project_id))].join(' / '))
const when = (value?: string | null) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })

async function load(again = false, cause: 'selection' | 'submission' | 'changed' = 'changed') {
  const current = ++request
  previewValid.value = false
  loading.value = !again
  reloading.value = again
  reloadCause.value = cause
  error.value = ''
  try {
    const value = sourceTarget.value
      ? await previewSourceDelete(props.spaceId, sourceTarget.value, selection.value)
      : await previewHardDelete(props.spaceId, props.item as KnowledgeItemSummary)
    if (current === request) { rawPreview.value = value; previewValid.value = true }
  } catch (cause) {
    if (current !== request) return
    const deleted = hardDeletedFrom(cause, props.item.item_kind)
    if (deleted) emit('deleted', deleted)
    else error.value = ledgerDamage(cause) ?? t('knowledgeHardDelete.dialog.loadFailed', { error: apiErrorReason(cause) })
  } finally {
    if (current === request) { loading.value = false; reloading.value = false }
  }
}

function select(key: string, checked: boolean) {
  if (!sourcePreview.value || deleting.value) return
  selection.value = sourceSelection(selection.value, key, checked, sourcePreview.value.default_items.some(row => row.key === key))
  typed.value = ''
  notice.value = t('knowledgeHardDelete.source.selectionChanged')
  void load(true, 'selection')
}

function resetSelection() {
  if (!sourcePreview.value || deleting.value) return
  selection.value = { include: [...sourcePreview.value.include], exclude: [...sourcePreview.value.exclude] }
  typed.value = ''
  void load(true, 'selection')
}

function recheckSubmissions() {
  if (deleting.value || reloading.value) return
  typed.value = ''
  notice.value = ''
  void load(true, 'submission')
}

async function submit() {
  if (!preview.value || !ready.value || deleting.value) return
  deleting.value = true
  error.value = ''
  notice.value = ''
  try {
    emit('deleted', deletedState(sourceTarget.value && sourcePreview.value
      ? await confirmSourceDelete(props.spaceId, sourceTarget.value, sourcePreview.value, typed.value)
      : await confirmHardDelete(props.spaceId, rawPreview.value as HardDeletePreview, typed.value)))
  } catch (cause) {
    const deleted = hardDeletedFrom(cause, props.item.item_kind)
    if (deleted) { emit('deleted', deleted); return }
    if (stalePreview(cause)) {
      typed.value = ''
      notice.value = t('knowledgeHardDelete.dialog.stale')
      await load(true)
      return
    }
    // Only the graph's own refusal proves nothing was deleted; anything else
    // is a result to check, never "nothing was deleted". A damaged record
    // stops the delete before anything is sent, and says how to repair it.
    const damage = ledgerDamage(cause)
    if (damage) error.value = damage
    else if (refusedByGraph(cause)) error.value = t('knowledgeHardDelete.dialog.failed', { error: apiErrorReason(cause) })
    else emit('deleted', { outcome: 'unknown', deletedAt: null })
  } finally {
    deleting.value = false
  }
}

watch(() => [props.spaceId, props.item.item_kind, props.item.item_id, sourceTarget.value?.sourceApplication,
  sourceTarget.value?.sessionId], () => {
  rawPreview.value = null
  selection.value = { include: [], exclude: [] }
  typed.value = ''
  notice.value = ''
  void load()
}, { immediate: true })
</script>

<template>
  <DialogHeader>
    <DialogTitle>{{ t(sourceTarget ? `knowledgeHardDelete.source.${sourceTarget.item_kind}Title` : 'knowledgeHardDelete.dialog.title') }}</DialogTitle>
    <DialogDescription>{{ t('knowledgeHardDelete.dialog.description') }}</DialogDescription>
  </DialogHeader>
  <GrowthLoading v-if="loading" variant="compact" :label="t('knowledgeHardDelete.dialog.loading')" />
  <p v-else-if="error && !preview" role="alert" class="m-0 text-sm text-destructive" data-hard-delete-error>{{ error }}</p>
  <div v-else-if="preview" class="grid min-w-0 gap-5 text-sm" data-hard-delete-preview>
    <GrowthLoading v-if="reloading && reloadCause !== 'submission'" variant="inline" :label="t(reloadCause === 'selection' ? 'knowledgeHardDelete.source.reloading' : 'knowledgeHardDelete.dialog.reloading')" />
    <p v-if="notice" role="status" class="m-0 font-medium" data-hard-delete-notice>{{ notice }}</p>

    <section v-if="preview.publications?.length" class="grid min-w-0 gap-2 rounded-lg border p-3 [overflow-wrap:anywhere]" data-hard-delete-publications>
      <h3 class="m-0 text-base font-semibold">{{ t('knowledgeHardDelete.dialog.publications') }}</h3>
      <p class="m-0">{{ t(preview.removed_episodes.length ? 'knowledgeHardDelete.dialog.publicationWarning' : 'knowledgeHardDelete.dialog.publicationItemWarning', { project: publicProjects }) }}</p>
      <ul class="m-0 grid list-none gap-2 p-0">
        <li v-for="publication in preview.publications" :key="publication.draft_id" class="grid gap-1 [overflow-wrap:anywhere]">
          <p class="m-0 font-medium">{{ publication.project_name || publication.project_id }}</p>
          <p class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.dialog.publicationLocation', { location: publication.provider_url, submission: publication.proposal_id }) }}</p>
        </li>
      </ul>
      <p class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.dialog.withdrawalUnavailable', { project: publicProjects }) }}</p>
      <p v-if="!sourcePreview && preview.drafts?.submitted" class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.dialog.submissionCopyScrubbed') }}</p>
    </section>

    <section v-if="!sourcePreview" class="grid gap-2" data-hard-delete-items>
      <h3 class="m-0 text-base font-semibold">{{ t('knowledgeHardDelete.dialog.removed') }}</h3>
      <ul class="m-0 grid list-none gap-2 p-0">
        <li v-for="row in preview.items" :key="`${row.item_kind}:${row.item_id}`"
          class="grid min-w-0 gap-1 rounded-lg border bg-muted/40 p-3" :data-hard-delete-item="row.role">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{{ t(`knowledgeHardDelete.dialog.roles.${row.role}`) }}</Badge>
            <Badge :variant="versionTone(row.status)">{{ versionStatusLabel(row.status) }}</Badge>
          </div>
          <p class="m-0 [overflow-wrap:anywhere]">{{ row.content || row.title }}</p>
        </li>
      </ul>
    </section>

    <section class="grid gap-2" data-hard-delete-sources>
      <h3 class="m-0 text-base font-semibold">{{ t('knowledgeHardDelete.dialog.sources') }}</h3>
      <p class="m-0">{{ t(sourcePreview ? 'knowledgeHardDelete.source.removedSources' : 'knowledgeHardDelete.dialog.removedSources', { count: preview.removed_episodes.length }) }}</p>
      <p v-if="sourcePreview" class="m-0" data-source-conversation-counts>{{ t('knowledgeHardDelete.source.conversations', {
        turns: sourcePreview.counts.source_turns, events: sourcePreview.counts.conversation_events, summaries: sourcePreview.counts.conversation_summaries }) }}</p>
      <p v-if="sourcePreview && preview.drafts?.submitted" class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.dialog.submissionCopyScrubbed') }}</p>
      <p v-if="preview.drafts?.submitting" class="m-0" data-drafts-submitting>{{ t('knowledgeHardDelete.dialog.draftsSubmitting', { count: preview.drafts.submitting }) }}</p>
      <p v-if="preview.drafts?.unknown" class="m-0" data-drafts-unknown>{{ t('knowledgeHardDelete.dialog.draftsUnknown', { count: preview.drafts.unknown }) }}</p>
      <div v-if="preview.drafts?.submitting || preview.drafts?.unknown" class="grid justify-items-start gap-2" data-drafts-recheck>
        <GrowthLoading v-if="reloading && reloadCause === 'submission'" variant="inline" :label="t('knowledgeHardDelete.dialog.recheckingSubmissions')" />
        <Button type="button" variant="outline" size="sm" :disabled="deleting || reloading" @click="recheckSubmissions">{{ t('knowledgeHardDelete.dialog.recheckSubmissions') }}</Button>
      </div>
      <p v-if="preview.drafts?.pending" class="m-0">{{ t('knowledgeHardDelete.dialog.pendingDraftsVoided', { count: preview.drafts.pending }) }}</p>
      <ul v-if="preview.removed_episodes.length" class="m-0 grid list-none gap-2 p-0">
        <li v-for="episode in preview.removed_episodes" :key="episode.episode_id"
          class="grid min-w-0 gap-1 rounded-lg border bg-muted/40 p-3" data-hard-delete-episode="removed">
          <span class="text-muted-foreground">{{ evidenceKindLabel(episode) }} · {{ evidenceApplicationLabel(episode) }} · {{ when(episode.created_at) }}</span>
          <span class="[overflow-wrap:anywhere]">{{ episode.excerpt || t('knowledgeHardDelete.dialog.noExcerpt') }}</span>
        </li>
      </ul>
      <p v-if="preview.kept_episodes.length" class="m-0">{{ t('knowledgeHardDelete.dialog.keptSources', { count: preview.kept_episodes.length }) }}</p>
      <ul v-if="preview.kept_episodes.length" class="m-0 grid list-none gap-2 p-0">
        <li v-for="episode in preview.kept_episodes" :key="episode.episode_id"
          class="grid min-w-0 gap-1 rounded-lg border p-3" data-hard-delete-episode="kept">
          <span class="text-muted-foreground">{{ evidenceKindLabel(episode) }} · {{ evidenceApplicationLabel(episode) }} · {{ when(episode.created_at) }}</span>
          <span class="[overflow-wrap:anywhere]">{{ episode.excerpt || t('knowledgeHardDelete.dialog.noExcerpt') }}</span>
          <span>{{ t('knowledgeHardDelete.dialog.keptSourceItems', { count: episode.other_items }) }}</span>
          <ul class="m-0 grid list-none gap-1 p-0">
            <li v-for="user in episode.used_by ?? []" :key="`${user.item_kind}:${user.item_id}`" class="min-w-0">
              <RouterLink :to="itemEditPath(spaceId, user)" class="underline underline-offset-4 [overflow-wrap:anywhere]"
                data-hard-delete-kept-user>{{ user.title }}</RouterLink>
            </li>
          </ul>
        </li>
      </ul>
      <p v-if="preview.kept_episodes.length" class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.dialog.keptSourceHelp') }}</p>
    </section>

    <SourceDeleteSelections v-if="sourcePreview" :preview="sourcePreview" :disabled="deleting || reloading" @select="select" />

    <section class="grid gap-2" data-hard-delete-records>
      <h3 class="m-0 text-base font-semibold">{{ t('knowledgeHardDelete.dialog.records') }}</h3>
      <ul v-if="records.length" class="m-0 flex list-none flex-wrap gap-2 p-0">
        <li v-for="row in records" :key="row.key"><Badge variant="secondary" :data-hard-delete-count="row.key">
          {{ t(`knowledgeHardDelete.dialog.counts.${row.key}`, { count: row.count }) }}</Badge></li>
      </ul>
      <p v-else class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.dialog.noRecords') }}</p>
    </section>

    <section v-if="preview.dependents.length" class="grid gap-2" data-hard-delete-dependents>
      <h3 class="m-0 text-base font-semibold">{{ t('knowledgeHardDelete.dialog.dependents') }}</h3>
      <p class="m-0">{{ t('knowledgeHardDelete.dialog.dependentsHelp', { count: preview.dependents.length }) }}</p>
      <ul class="m-0 grid list-none gap-2 p-0">
        <li v-for="row in preview.dependents" :key="`${row.item_kind}:${row.item_id}`"
          class="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border p-3" data-hard-delete-dependent>
          <Badge v-if="!row.direct" variant="outline">{{ t('knowledgeHardDelete.dialog.below') }}</Badge>
          <RouterLink :to="itemEditPath(spaceId, row)" class="min-w-0 underline underline-offset-4 [overflow-wrap:anywhere]"
            data-hard-delete-dependent-link>{{ row.content || row.title }}</RouterLink>
        </li>
      </ul>
    </section>

    <section class="grid gap-1 text-muted-foreground" data-hard-delete-kept>
      <h3 class="m-0 text-base font-semibold text-foreground">{{ t('knowledgeHardDelete.dialog.notRemoved') }}</h3>
      <p class="m-0">{{ t(sourcePreview ? 'knowledgeHardDelete.source.retained' : 'knowledgeHardDelete.dialog.notRemovedShared') }}</p>
      <p v-if="preview.item_kind === 'relationship' || preview.counts.relationships" class="m-0">{{ t('knowledgeHardDelete.dialog.notRemovedEndpoints') }}</p>
      <p class="m-0">{{ t('knowledgeHardDelete.dialog.notRemovedWorkflow') }}</p>
      <p v-if="!preview.publications?.length" class="m-0">{{ t('knowledgeHardDelete.dialog.notRemovedPublic') }}</p>
      <p class="m-0">{{ t('knowledgeHardDelete.dialog.trace') }}</p>
      <p class="m-0 text-foreground" data-hard-delete-disclosure>{{ t('knowledgeHardDelete.dialog.disclosure') }}</p>
    </section>

    <form class="grid gap-3" @submit.prevent="submit">
      <Field>
        <FieldLabel for="hard-delete-confirm">{{ t('knowledgeHardDelete.dialog.confirmLabel') }}</FieldLabel>
        <Input id="hard-delete-confirm" v-model="typed" autocomplete="off" maxlength="512" :disabled="deleting || reloading"
          data-hard-delete-confirm />
        <FieldDescription>{{ t('knowledgeHardDelete.dialog.confirmHelp') }}</FieldDescription>
      </Field>
      <p v-if="error" role="alert" class="m-0 text-destructive" data-hard-delete-error>{{ error }}</p>
      <Button v-if="error && sourcePreview && !previewValid" type="button" variant="outline" :disabled="reloading" data-source-reset-selection @click="resetSelection">{{ t('knowledgeHardDelete.source.resetSelection') }}</Button>
      <DialogFooter class="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" :disabled="deleting" @click="emit('cancel')">{{ t('knowledgeHardDelete.dialog.cancel') }}</Button>
        <Button type="submit" variant="destructive" :disabled="!ready || reloading" :loading="deleting"
          :loading-label="t(sourceTarget ? 'knowledgeHardDelete.source.deleting' : 'knowledgeHardDelete.dialog.deleting')" data-hard-delete-submit>{{ t('knowledgeHardDelete.dialog.submit') }}</Button>
      </DialogFooter>
    </form>
  </div>
</template>
