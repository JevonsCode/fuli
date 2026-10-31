<script setup lang="ts">
import { computed } from 'vue'

import { Card } from '@/components/ui/card'
import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import KnowledgeDeleteButton from './KnowledgeDeleteButton.vue'
import type { SourceDeleteTarget } from './source-delete-model'
import type { HardDeletedState } from './model'

// rec#5 C9, rec#11 D-88: 「删除…」 sits at the end of the item page, one click
// from the dialog that lists what goes and asks once.
const props = defineProps<{ item: KnowledgeItemSummary | SourceDeleteTarget; spaceId: string }>()
const sourceKind = computed(() => props.item.item_kind === 'episode' || props.item.item_kind === 'session' ? props.item.item_kind : null)
const emit = defineEmits<{ deleted: [state: HardDeletedState] }>()
</script>

<template>
  <Card as="section" class="grid justify-items-start gap-3 px-5 py-4 text-sm" data-hard-delete-section>
    <p class="m-0 text-muted-foreground">{{ t(sourceKind ? 'knowledgeHardDelete.source.dangerHelp' : 'knowledgeHardDelete.danger.help') }}</p>
    <KnowledgeDeleteButton :item="item" :space-id="spaceId"
      :label="t(sourceKind ? `knowledgeHardDelete.source.${sourceKind}Open` : 'knowledgeHardDelete.danger.open')"
      @deleted="emit('deleted', $event)" />
  </Card>
</template>
