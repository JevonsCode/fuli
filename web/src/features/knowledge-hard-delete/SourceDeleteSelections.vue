<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { versionStatusLabel, versionTone } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import { sourceRowTitle, type SourceDeletePreview } from './source-delete-model'
defineProps<{ preview: SourceDeletePreview; disabled: boolean }>()
const emit = defineEmits<{ select: [key: string, selected: boolean] }>()
</script>

<template>
  <section v-for="layer in ['default_items', 'affected_items'] as const" :key="layer" class="grid gap-2" :data-source-layer="layer">
    <h3 class="m-0 text-base font-semibold">{{ t(`knowledgeHardDelete.source.${layer}`) }}</h3>
    <p class="m-0 text-muted-foreground">{{ t(`knowledgeHardDelete.source.${layer}Help`) }}</p>
    <p v-if="!preview[layer].length" class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.source.empty') }}</p>
    <div v-for="row in preview[layer]" :key="row.key" class="grid gap-2 rounded-lg border p-3" :data-source-row="row.key">
      <label class="flex cursor-pointer items-start gap-2">
        <Checkbox :model-value="row.selected" :disabled="disabled || (row.reason === 'attached_relationship' && row.selected)" :aria-label="t('knowledgeHardDelete.source.select', { title: sourceRowTitle(row) })"
          @update:model-value="emit('select', row.key, $event === true)" />
        <span class="grid min-w-0 gap-1 [overflow-wrap:anywhere]">
          <span class="font-medium">{{ sourceRowTitle(row) }}</span>
          <span class="text-muted-foreground">{{ t(`knowledgeHardDelete.source.reasons.${row.reason}`) }}<template v-if="layer !== 'affected_items' || !row.selected"> · {{ t('knowledgeHardDelete.source.sources', { count: row.source_count, retained: row.retained_source_count }) }}</template></span>
        </span>
      </label>
      <p v-if="layer === 'affected_items' && row.selected" class="m-0" data-source-added-consequence>{{ t('knowledgeHardDelete.source.addedConsequence', { retained: row.retained_source_count }) }}</p>
      <p v-if="row.reason === 'attached_relationship' && row.selected" class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.source.attached') }}</p>
      <p v-if="row.basis_changed && !row.selected" class="m-0 text-muted-foreground" data-source-basis-changed>{{ t('knowledgeHardDelete.source.basisChanged') }}</p>
      <ul class="m-0 grid list-none gap-2 p-0">
        <li v-for="version in row.versions" :key="`${version.item_kind}:${version.item_id}`" class="grid gap-1">
          <Badge :variant="versionTone(version.status)">{{ versionStatusLabel(version.status) }}</Badge>
          <span class="[overflow-wrap:anywhere]">{{ version.content || version.title }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
