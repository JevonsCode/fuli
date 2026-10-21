<script setup lang="ts">
import { RouterLink } from 'vue-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { sourceSessionPath } from '@/features/session-records/model'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import {
  changedByLabel, confirmationLabel, evidenceApplicationLabel, evidenceKindLabel, sourceLabel, versionPeekId,
  versionStatusLabel, versionTone, type ItemVersion, type KnowledgeItemView,
} from './model'

// Where the item came from and every change since: kept even after it is
// moved, edited or marked outdated (temporal history is never rewritten).
// Every version keeps its own words, source label and confirmation, who wrote
// it and why (rec#5 C7); one opens in a quick look. A source from a host
// session links back to that session's records, opened at the turn that wrote
// it (rec#5 C6-3).
defineProps<{ item: KnowledgeItemView; spaceId: string }>()
const emit = defineEmits<{ openVersion: [version: ItemVersion] }>()

const when = (value?: string | null) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })
const action = (value: string) => t(`knowledgeQuickEdit.history.actions.${value}`)
</script>

<template>
  <Card as="section" data-item-history>
    <CardHeader><CardTitle as="h2">{{ t('knowledgeQuickEdit.history.title') }}</CardTitle></CardHeader>
    <div class="grid gap-4 px-5 text-sm">
      <section v-if="(item.versions?.length ?? 0) > 1" class="grid gap-2" data-item-versions>
        <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeQuickEdit.history.versions') }} · {{ item.versions!.length }}</h3>
        <ol class="m-0 grid list-none gap-2 p-0">
          <li v-for="version in item.versions" :key="version.item_id" :data-return-focus="versionPeekId(version)">
            <Button variant="ghost" aria-haspopup="dialog" :aria-current="version.item_id === item.item_id ? 'true' : undefined"
              class="h-auto w-full min-w-0 flex-col items-stretch gap-1 rounded-md border bg-card px-3 py-2 text-left font-normal whitespace-normal"
              :class="version.item_id === item.item_id ? 'border-border-strong shadow-md' : ''"
              :data-version="version.status" @click="emit('openVersion', version)">
              <span class="flex flex-wrap items-center gap-1.5">
                <Badge :variant="versionTone(version.status)">{{ versionStatusLabel(version.status) }}</Badge>
                <Badge v-if="version.item_id === item.item_id" variant="outline" data-version-viewing>{{ t('knowledgeQuickEdit.history.viewing') }}</Badge>
              </span>
              <!-- Who and when, then source and confirmation: two segments on their own line, each wrapping whole. -->
              <span class="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span class="whitespace-nowrap" data-version-who>{{ when(version.created_at) }} · {{ changedByLabel(version.changed_by) }}</span>
                <span class="whitespace-nowrap" data-version-evidence>{{ sourceLabel(version) }} · {{ confirmationLabel(version) }}</span>
              </span>
              <span class="line-clamp-2 [overflow-wrap:anywhere]">{{ version.content }}</span>
              <span v-if="version.reason" class="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {{ t('knowledgeQuickEdit.history.reason', { reason: version.reason }) }}
              </span>
              <span v-if="version.released_bases?.length" class="text-xs text-muted-foreground" data-released-bases>
                {{ t('knowledgeQuickEdit.history.releasedBases', { count: version.released_bases.length }) }}
              </span>
            </Button>
          </li>
        </ol>
      </section>
      <section class="grid gap-2" data-item-sources>
        <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeQuickEdit.history.sources') }} · {{ item.evidence_count }}</h3>
        <ol v-if="item.evidence.length" class="m-0 grid list-none gap-2 p-0">
          <li v-for="source in item.evidence" :key="source.episode_id" class="grid gap-0.5 rounded-md border px-3 py-2">
            <span class="text-xs text-muted-foreground">
              {{ when(source.created_at) }} · {{ evidenceApplicationLabel(source) }} · {{ evidenceKindLabel(source) }}
              <template v-if="source.session_id"> · {{ t('knowledgeQuickEdit.history.session', { id: source.session_id.slice(0, 8) }) }}</template>
            </span>
            <span v-if="source.excerpt" class="break-words">{{ source.excerpt }}</span>
            <RouterLink v-if="sourceSessionPath(spaceId, source)" :to="sourceSessionPath(spaceId, source)"
              class="justify-self-start text-xs underline underline-offset-4" data-source-session>
              {{ t('sessionRecords.fromSession') }}
            </RouterLink>
          </li>
        </ol>
        <p v-else class="m-0 text-muted-foreground">{{ t('knowledgeQuickEdit.history.noSources') }}</p>
      </section>
      <section class="grid gap-2" data-item-revisions>
        <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeQuickEdit.history.revisions') }}</h3>
        <ol v-if="item.revisions.length" class="m-0 grid list-none gap-1.5 p-0">
          <li v-for="revision in item.revisions" :key="revision.id" class="flex flex-wrap gap-x-2">
            <span class="text-xs text-muted-foreground">{{ when(revision.created_at) }}</span>
            <span class="font-medium">{{ action(revision.action) }}</span>
            <span v-if="revision.changed_by" class="text-xs text-muted-foreground">{{ changedByLabel(revision.changed_by) }}</span>
            <span class="min-w-0 break-words">{{ revision.reason }}</span>
          </li>
        </ol>
        <p v-else class="m-0 text-muted-foreground">{{ t('knowledgeQuickEdit.history.noRevisions') }}</p>
      </section>
    </div>
  </Card>
</template>
