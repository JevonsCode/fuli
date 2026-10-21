<script setup lang="ts">
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import type { KnowledgeItemView } from './model'

// Where the item came from and every change since: kept even after it is
// moved, edited or deactivated (temporal history is never rewritten).
defineProps<{ item: KnowledgeItemView }>()

const when = (value?: string | null) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })
const action = (value: string) => t(`knowledgeQuickEdit.history.actions.${value}`)
</script>

<template>
  <Card as="section" data-item-history>
    <CardHeader><CardTitle as="h2">{{ t('knowledgeQuickEdit.history.title') }}</CardTitle></CardHeader>
    <div class="grid gap-4 px-5 text-sm">
      <section class="grid gap-2" data-item-sources>
        <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeQuickEdit.history.sources') }} · {{ item.evidence_count }}</h3>
        <ol v-if="item.evidence.length" class="m-0 grid list-none gap-2 p-0">
          <li v-for="source in item.evidence" :key="source.episode_id" class="grid gap-0.5 rounded-md border px-3 py-2">
            <span class="text-xs text-muted-foreground">
              {{ when(source.created_at) }} · {{ source.source_application || '—' }} · {{ source.source_kind || '—' }}
              <template v-if="source.session_id"> · {{ t('knowledgeQuickEdit.history.session', { id: source.session_id.slice(0, 8) }) }}</template>
            </span>
            <span v-if="source.excerpt" class="break-words">{{ source.excerpt }}</span>
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
            <span class="min-w-0 break-words">{{ revision.reason }}</span>
          </li>
        </ol>
        <p v-else class="m-0 text-muted-foreground">{{ t('knowledgeQuickEdit.history.noRevisions') }}</p>
      </section>
    </div>
  </Card>
</template>
