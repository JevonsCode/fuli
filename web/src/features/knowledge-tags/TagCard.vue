<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { statusLabel, statusTone, type TagEntry } from './model'

// One tag of the vocabulary. The chosen one lifts as a card; there is no side accent.
defineProps<{ tag: TagEntry; selected: boolean }>()
defineEmits<{ open: [] }>()
</script>

<template>
  <article class="flex h-full min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 transition-[border-color,box-shadow]"
    :class="selected ? 'border-border-strong shadow-md' : 'hover:border-border-strong'"
    :data-tag-card="tag.id" :data-return-focus="tag.id" :data-selected="selected || undefined">
    <div class="flex min-w-0 items-start justify-between gap-2">
      <h3 class="m-0 min-w-0 text-base leading-snug font-semibold">
        <Button variant="link" aria-haspopup="dialog" data-tag-open
          class="h-auto min-h-0 justify-start p-0 text-left text-base font-semibold whitespace-normal text-foreground underline-offset-4 hover:text-primary hover:underline"
          :aria-label="t('knowledgeTags.open', { name: tag.name })" @click="$emit('open')">
          <span class="[overflow-wrap:anywhere]">{{ tag.name }}</span>
        </Button>
      </h3>
      <Badge :variant="statusTone(tag.status)" class="shrink-0" data-tag-status>{{ statusLabel(tag.status) }}</Badge>
    </div>
    <p v-if="tag.description" class="m-0 line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">{{ tag.description }}</p>
    <div v-if="tag.aliases.length || tag.proposed_aliases.length" class="flex min-w-0 flex-wrap items-center gap-1.5"
      :aria-label="t('knowledgeTags.aliases')">
      <Badge v-for="alias in tag.aliases" :key="`a-${alias}`" :title="tag.provisional_aliases.includes(alias)
        ? t('knowledgeTags.aliasProvisional') : alias" :variant="tag.provisional_aliases.includes(alias) ? 'warning' : 'outline'">
        {{ alias }}
      </Badge>
      <Badge v-for="alias in tag.proposed_aliases" :key="`p-${alias}`" variant="outline" class="border-dashed"
        :title="t('knowledgeTags.aliasProposed')">{{ alias }}?</Badge>
    </div>
    <p v-if="tag.merged_into" class="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-tag-merged-into>
      {{ t('knowledgeTags.mergedInto', { name: tag.merged_into.name }) }}
    </p>
    <dl v-if="tag.parents.length || tag.related.length" class="m-0 grid gap-0.5 text-xs text-muted-foreground">
      <div v-if="tag.parents.length" class="flex min-w-0 gap-1">
        <dt class="shrink-0">{{ t('knowledgeTags.parents') }}</dt>
        <dd class="m-0 [overflow-wrap:anywhere]">{{ tag.parents.map(parent => parent.name).join('、') }}</dd>
      </div>
      <div v-if="tag.related.length" class="flex min-w-0 gap-1">
        <dt class="shrink-0">{{ t('knowledgeTags.related') }}</dt>
        <dd class="m-0 [overflow-wrap:anywhere]">{{ tag.related.map(related => related.name).join('、') }}</dd>
      </div>
    </dl>
    <footer class="mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
      <span class="tabular-nums" data-tag-linked>
        {{ tag.linked_items === null ? t('knowledgeTags.linkedHidden') : t('knowledgeTags.linked', { count: tag.linked_items }) }}
      </span>
      <span>{{ t(`knowledgeTags.source.${tag.source.kind}`) }}</span>
    </footer>
  </article>
</template>
