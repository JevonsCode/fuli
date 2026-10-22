<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import {
  historyActionLabel, isLive, namespaceLabel, statusLabel, statusTone,
  type GovernanceChange, type RelationKind, type TagDetail, type TagRef,
} from './model'
import TagGovernancePanel from './TagGovernancePanel.vue'
import { acceptAlias, readTagDetail } from './tags-api'

// One tag in a dialog: its aliases, relations, linked knowledge and history,
// and the person's governance of it. A change opens in the same dialog; after
// it the tag is read again and the page refreshes its list.
const LINKS_SHOWN = 20
const props = defineProps<{
  spaceId: string
  tagId: string
  name: string
  projectNames: ReadonlyMap<string, string>
  initialChange?: GovernanceChange | null
  initialTarget?: TagRef | null
}>()
const emit = defineEmits<{ changed: [] }>()

interface Mode { change: GovernanceChange; target?: TagRef | null; relation?: RelationKind; alias?: string; operationId?: string }
const detail = ref<TagDetail | null>(null)
const loading = ref(false)
const error = ref('')
const mode = ref<Mode | null>(props.initialChange ? { change: props.initialChange, target: props.initialTarget } : null)
const accepting = ref('')
const actionError = ref('')
const done = ref(false)
const showAllLinks = ref(false)
let request = 0

const tag = computed(() => detail.value?.tag ?? null)
const live = computed(() => Boolean(tag.value && isLive(tag.value)))
const latestUndo = computed(() => detail.value?.history.find(entry => entry.undoable) ?? null)
const links = computed(() => (detail.value?.links ?? []).slice(0, showAllLinks.value ? undefined : LINKS_SHOWN))
const when = (value: string | null) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })

async function load() {
  const current = ++request
  loading.value = true
  error.value = ''
  try {
    const value = await readTagDetail(props.spaceId, props.tagId)
    if (current === request) detail.value = value
  } catch (cause) {
    if (current === request) error.value = apiErrorReason(cause)
  } finally {
    if (current === request) loading.value = false
  }
}

async function changed() {
  mode.value = null
  done.value = true
  emit('changed')
  await load()
}

async function accept(alias: string) {
  if (!tag.value || accepting.value) return
  accepting.value = alias
  actionError.value = ''
  try {
    await acceptAlias(props.spaceId, tag.value, alias, t('knowledgeTags.acceptReason'))
    await changed()
  } catch (cause) {
    actionError.value = t('knowledgeTags.actionFailed', { error: apiErrorReason(cause) })
  } finally {
    accepting.value = ''
  }
}

function open(next: Mode) {
  done.value = false
  actionError.value = ''
  mode.value = next
}

watch(() => props.tagId, () => { detail.value = null; void load() }, { immediate: true })
</script>

<template>
  <GrowthLoading v-if="loading && !detail" variant="compact" :label="t('knowledgeTags.detail.loading', { name })" />
  <div v-else-if="error && !detail" role="alert" class="grid justify-items-start gap-2">
    <DialogTitle class="[overflow-wrap:anywhere]">{{ name }}</DialogTitle>
    <p class="m-0 text-sm text-destructive [overflow-wrap:anywhere]">{{ t('knowledgeTags.detail.loadFailed', { error }) }}</p>
    <Button variant="outline" size="sm" @click="load">{{ t('knowledgeTags.retry') }}</Button>
  </div>
  <TagGovernancePanel v-else-if="detail && mode" :key="`${mode.change}:${mode.operationId ?? ''}:${mode.alias ?? ''}`"
    :space-id="spaceId" :detail="detail" :change="mode.change" :initial-target="mode.target"
    :initial-relation="mode.relation" :alias="mode.alias" :operation-id="mode.operationId"
    @done="changed" @back="mode = null" />
  <div v-else-if="detail && tag" class="grid min-w-0 gap-5" :data-tag-detail="tag.id">
    <DialogHeader>
      <DialogTitle class="[overflow-wrap:anywhere]">{{ tag.name }}</DialogTitle>
      <DialogDescription class="flex flex-wrap items-center gap-2">
        <span>{{ namespaceLabel(tag, projectNames) }}</span>
        <Badge :variant="statusTone(tag.status)">{{ statusLabel(tag.status) }}</Badge>
        <span>{{ t(`knowledgeTags.source.${tag.source.kind}`) }}</span>
      </DialogDescription>
    </DialogHeader>
    <GrowthLoading v-if="loading" variant="inline" :label="t('knowledgeTags.detail.loading', { name: tag.name })" />
    <p v-if="done" role="status" class="m-0 text-sm text-success" data-tag-done>{{ t('knowledgeTags.governance.done') }}</p>
    <p v-if="actionError" role="alert" class="m-0 text-sm text-destructive">{{ actionError }}</p>

    <section class="grid gap-1">
      <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeTags.detail.description') }}</h3>
      <p class="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">{{ tag.description || t('knowledgeTags.detail.noDescription') }}</p>
      <p v-if="tag.merged_into" class="m-0 text-sm [overflow-wrap:anywhere]">{{ t('knowledgeTags.mergedInto', { name: tag.merged_into.name }) }}</p>
    </section>

    <section v-if="tag.aliases.length || tag.proposed_aliases.length" class="grid gap-2" data-tag-aliases>
      <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeTags.aliases') }}</h3>
      <ul class="m-0 grid list-none gap-2 p-0">
        <li v-for="alias in [...tag.aliases, ...tag.proposed_aliases]" :key="alias"
          class="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span class="min-w-0 font-medium [overflow-wrap:anywhere]">{{ alias }}</span>
          <Badge v-if="tag.provisional_aliases.includes(alias)" variant="warning">{{ t('knowledgeTags.aliasProvisional') }}</Badge>
          <Badge v-else-if="tag.proposed_aliases.includes(alias)" variant="outline" class="border-dashed">{{ t('knowledgeTags.aliasProposed') }}</Badge>
          <span v-if="live" class="ml-auto flex flex-wrap gap-1">
            <Button v-if="tag.provisional_aliases.includes(alias) || tag.proposed_aliases.includes(alias)" size="sm"
              variant="outline" :loading="accepting === alias" :loading-label="t('knowledgeTags.acceptingAlias', { alias })"
              :data-tag-accept-alias="alias" @click="accept(alias)">{{ t('knowledgeTags.acceptAlias', { alias }) }}</Button>
            <Button size="sm" variant="ghost" :data-tag-remove-alias="alias"
              @click="open({ change: 'remove_alias', alias })">{{ t('knowledgeTags.rejectAlias', { alias }) }}</Button>
          </span>
        </li>
      </ul>
    </section>

    <section class="grid gap-2" data-tag-relations>
      <dl class="m-0 grid gap-2 text-sm">
        <div v-for="group in ([['parents', tag.parents, 'parent'], ['related', tag.related, 'related']] as const)"
          :key="group[0]" class="grid gap-1">
          <dt class="font-semibold">{{ t(`knowledgeTags.${group[0]}`) }}</dt>
          <dd class="m-0 flex flex-wrap items-center gap-1.5">
            <span v-if="!group[1].length" class="text-muted-foreground">{{ t('knowledgeTags.detail.none') }}</span>
            <span v-for="other in group[1]" :key="other.id" class="inline-flex items-center gap-1">
              <Badge variant="secondary">{{ other.name }}</Badge>
              <Button v-if="live" size="sm" variant="ghost" class="h-6 px-1.5 text-xs" :data-tag-unrelate="other.id"
                :aria-label="`${t('knowledgeTags.actions.unrelate')} ${other.name}`"
                @click="open({ change: 'unrelate', target: other, relation: group[2] })">{{ t('knowledgeTags.actions.unrelate') }}</Button>
            </span>
          </dd>
        </div>
        <div v-if="detail.children.length" class="grid gap-1">
          <dt class="font-semibold">{{ t('knowledgeTags.detail.children') }}</dt>
          <dd class="m-0 flex flex-wrap gap-1.5"><Badge v-for="child in detail.children" :key="child.id" variant="secondary">{{ child.name }}</Badge></dd>
        </div>
        <div v-if="detail.merged_from.length" class="grid gap-1">
          <dt class="font-semibold">{{ t('knowledgeTags.detail.mergedFrom') }}</dt>
          <dd class="m-0 flex flex-wrap gap-1.5"><Badge v-for="merged in detail.merged_from" :key="merged.id" variant="outline">{{ merged.name }}</Badge></dd>
        </div>
      </dl>
    </section>

    <section class="grid gap-2" data-tag-links>
      <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeTags.detail.links') }} <span class="font-normal text-muted-foreground tabular-nums">{{ tag.linked_items ?? '' }}</span></h3>
      <p v-if="!detail.links?.length" class="m-0 text-sm text-muted-foreground">{{ t('knowledgeTags.detail.noLinks') }}</p>
      <ul v-else class="m-0 grid list-none gap-1.5 p-0 text-sm">
        <li v-for="link in links" :key="`${link.item_kind}:${link.item_id}`" class="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span class="min-w-0 [overflow-wrap:anywhere]">{{ link.title || t('knowledgeTags.detail.untitled') }}</span>
          <span v-if="link.moved_from" class="text-xs text-muted-foreground">{{ t('knowledgeTags.detail.movedFrom', { name: link.moved_from.name }) }}</span>
        </li>
      </ul>
      <Button v-if="!showAllLinks && (detail.links?.length ?? 0) > LINKS_SHOWN" size="sm" variant="ghost" class="justify-self-start"
        @click="showAllLinks = true">{{ t('knowledgeTags.loadMore', { count: (detail.links?.length ?? 0) - LINKS_SHOWN }) }}</Button>
      <p v-if="detail.links_truncated" class="m-0 text-xs text-muted-foreground">{{ t('knowledgeTags.detail.linksTruncated') }}</p>
    </section>

    <section class="grid gap-2" data-tag-history>
      <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeTags.detail.history') }}</h3>
      <ol class="m-0 grid list-none gap-2 p-0">
        <li v-for="entry in detail.history" :key="`${entry.version}:${entry.action}:${entry.created_at}`"
          class="grid min-w-0 gap-0.5 rounded-lg border bg-card px-3 py-2 text-sm" :data-tag-history-entry="entry.action">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="font-medium">{{ historyActionLabel(entry.action) }}</span>
            <Badge v-if="entry.other" variant="secondary">{{ entry.other.name }}</Badge>
            <Badge v-if="entry.alias" variant="outline">{{ entry.alias }}</Badge>
            <Badge v-if="entry.undone" variant="outline">{{ t('knowledgeTags.detail.undone') }}</Badge>
            <span class="ml-auto text-xs text-muted-foreground">
              {{ entry.actor_kind === 'human' ? t('knowledgeTags.detail.byHuman') : t('knowledgeTags.detail.byAgent') }} · {{ when(entry.created_at) }}
            </span>
          </div>
          <p v-if="entry.reason" class="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{{ entry.reason }}</p>
          <Button v-if="entry.undoable" size="sm" variant="outline" class="justify-self-start" data-tag-undo-entry
            @click="open({ change: 'undo', operationId: entry.operation_id ?? undefined })">{{ t('knowledgeTags.detail.undo') }}</Button>
        </li>
      </ol>
    </section>

    <DialogFooter class="flex-wrap justify-start gap-2 sm:justify-start" :aria-label="t('knowledgeTags.actions.label')">
      <Button v-if="tag.status === 'provisional'" data-tag-action="approve" @click="open({ change: 'approve' })">{{ t('knowledgeTags.actions.approve') }}</Button>
      <Button v-if="live" variant="outline" data-tag-action="merge" @click="open({ change: 'merge' })">{{ t('knowledgeTags.actions.merge') }}</Button>
      <Button v-if="live" variant="outline" data-tag-action="split" @click="open({ change: 'split' })">{{ t('knowledgeTags.actions.split') }}</Button>
      <Button v-if="live" variant="outline" data-tag-action="relate" @click="open({ change: 'relate' })">{{ t('knowledgeTags.actions.relate') }}</Button>
      <Button v-if="latestUndo" variant="outline" data-tag-action="undo"
        @click="open({ change: 'undo', operationId: latestUndo.operation_id ?? undefined })">{{ t('knowledgeTags.actions.undo') }}</Button>
      <Button v-if="live" variant="ghost" class="text-destructive" data-tag-action="retire" @click="open({ change: 'retire' })">{{ t('knowledgeTags.actions.retire') }}</Button>
    </DialogFooter>
  </div>
</template>
