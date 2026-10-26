<script setup lang="ts">
import SourceDeleteControl from '@/features/knowledge-hard-delete/SourceDeleteControl.vue'
import type { HardDeletedState } from '@/features/knowledge-hard-delete/model'
import { type SourceDeleteTarget } from '@/features/knowledge-hard-delete/source-delete-model'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import KnowledgeItemSummaryCard from '@/features/knowledge-quick-edit/KnowledgeItemSummaryCard.vue'
import { itemEditPath } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import { entryTypeLabel, projectLabel, recordedAt, type SessionEntry, type SessionRecordsView } from './model'

// One record of the session in the quick look. A turn shows the words it
// saved and what it recorded; a knowledge item or preference evidence shows
// what is stored now, the words it rests on, and the way to the turn that
// wrote it (C6-3) and to its quick edit. It renders inside the page's Dialog.
const props = defineProps<{ entry: SessionEntry | null; view: SessionRecordsView; spaceId: string }>()
const emit = defineEmits<{ open: [key: string]; close: []; sourceDeleted: [target: SourceDeleteTarget, state: HardDeletedState] }>()

const byKey = computed(() => new Map(props.view.entries.map(entry => [entry.key, entry])))
const turnRecords = computed(() => (props.entry?.detail.items ?? [])
  .map(key => byKey.value.get(key)).filter((entry): entry is SessionEntry => Boolean(entry)))
const sourceTurn = computed(() => props.entry?.turn ? byKey.value.get(props.entry.turn) ?? null : null)
const sources = computed(() => {
  const values = props.entry?.kind === 'turn'
    ? turnRecords.value.flatMap(record => record.detail.sources ?? []).filter(source => source.turn === props.entry?.key)
    : props.entry?.detail.sources ?? []
  return [...new Map(values.filter(source => source.episode_id).map(source => {
    const turn = source.turn ? byKey.value.get(source.turn) : null
    return [source.episode_id, { episodeId: source.episode_id, turn: turn ? `#${turn.number}` : '—', time: recordedAt(turn?.at) }]
  })).values()]
})
const item = computed(() => props.entry?.detail.item ?? null)
</script>

<template>
  <template v-if="!entry">
    <DialogHeader>
      <DialogTitle>{{ t('routes.sessionRecords.title') }}</DialogTitle>
      <DialogDescription>{{ t('sessionRecords.peek.missing') }}</DialogDescription>
    </DialogHeader>
    <DialogFooter class="border-t pt-4">
      <Button variant="outline" data-peek-close @click="emit('close')">{{ t('common.actions.close') }}</Button>
    </DialogFooter>
  </template>
  <template v-else>
    <DialogHeader>
      <DialogTitle class="pr-8 text-xl leading-tight [overflow-wrap:anywhere]">#{{ entry.number }} {{ entryTypeLabel(entry) }}</DialogTitle>
      <DialogDescription class="flex flex-wrap items-center gap-2">
        <span>{{ recordedAt(entry.at) }}</span><span aria-hidden="true">·</span><span>{{ projectLabel(entry.project) }}</span>
      </DialogDescription>
    </DialogHeader>

    <template v-if="entry.kind === 'turn'">
      <section v-for="(message, index) in entry.detail.messages ?? []" :key="index" class="grid gap-1 border-t pt-4 text-sm"
        :data-peek-message="message.role">
        <h3 class="m-0 text-xs font-semibold text-muted-foreground">
          {{ message.role === 'user' ? t('sessionRecords.peek.words') : t('sessionRecords.peek.reply') }}
        </h3>
        <p class="m-0 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{{ message.text }}</p>
      </section>
      <section class="grid gap-2 border-t pt-4 text-sm" data-peek-turn-records>
        <h3 class="m-0 text-xs font-semibold text-muted-foreground">{{ t('sessionRecords.peek.records') }}</h3>
        <ul v-if="turnRecords.length" class="m-0 grid list-none gap-1.5 p-0">
          <li v-for="record in turnRecords" :key="record.key">
            <Button variant="link" class="h-auto min-h-0 justify-start p-0 text-left whitespace-normal"
              @click="emit('open', record.key)">
              <span class="[overflow-wrap:anywhere]">#{{ record.number }} {{ entryTypeLabel(record) }} · {{ record.summary }}</span>
            </Button>
          </li>
        </ul>
        <p v-else class="m-0 text-muted-foreground">{{ t('sessionRecords.peek.noRecords') }}</p>
      </section>
    </template>

    <template v-else-if="item">
      <KnowledgeItemSummaryCard :item="item" />
      <section v-if="item.excerpt" class="grid gap-1 text-sm" data-peek-evidence>
        <h3 class="m-0 text-xs font-semibold text-muted-foreground">{{ t('sessionRecords.peek.evidence') }}</h3>
        <p v-if="!sourceTurn" class="m-0 text-xs text-muted-foreground">{{ t('sessionRecords.peek.notSaved') }}</p>
        <blockquote class="m-0 rounded-md bg-muted px-3 py-2 leading-relaxed [overflow-wrap:anywhere]">{{ item.excerpt }}</blockquote>
      </section>
      <div class="flex flex-wrap items-center gap-2">
        <Badge v-if="item.change === 'evidence'" variant="secondary">{{ t('sessionRecords.type.evidence') }}</Badge>
        <Button v-if="sourceTurn" variant="link" class="h-auto min-h-0 p-0" data-peek-source-turn
          @click="emit('open', sourceTurn.key)">{{ t('sessionRecords.peek.fromTurn', { number: sourceTurn.number }) }}</Button>
      </div>
    </template>

    <section v-if="sources.length" class="grid gap-2 border-t pt-4" data-source-delete-controls>
      <SourceDeleteControl v-for="source in sources" :key="source.episodeId" :space-id="spaceId" :target="{ item_kind: 'episode', item_id: source.episodeId }"
        :label="t('knowledgeHardDelete.source.episodeAt', { turn: source.turn, time: source.time })"
        @deleted="emit('sourceDeleted', { item_kind: 'episode', item_id: source.episodeId }, $event)" />
    </section>
    <DialogFooter class="border-t pt-4">
      <Button v-if="item" variant="outline" as-child>
        <RouterLink :to="itemEditPath(spaceId, item)" data-peek-edit>{{ t('sessionRecords.peek.edit') }}</RouterLink>
      </Button>
      <Button variant="outline" data-peek-close @click="emit('close')">{{ t('common.actions.close') }}</Button>
    </DialogFooter>
  </template>
</template>
