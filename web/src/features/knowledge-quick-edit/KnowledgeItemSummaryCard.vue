<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { t } from '@/i18n'
import UiWeight from '@/ui/UiWeight.vue'
import {
  categoryLabel, confirmationLabel, scopeLabel, sourceLabel, weightBasisLabel,
  type KnowledgeItemSummary,
} from './model'

// What is stored now: content, category, where it applies, the weight and what
// it rests on, tags, source and confirmation. Scope pending and content pending
// are two separate marks.
defineProps<{ item: KnowledgeItemSummary }>()
</script>

<template>
  <Card as="section" class="gap-3 px-5" data-item-summary :aria-label="item.title">
    <p class="m-0 text-base leading-relaxed whitespace-pre-wrap break-words" data-item-content>{{ item.content }}</p>
    <div class="flex flex-wrap gap-1.5">
      <Badge variant="secondary" data-item-category>{{ categoryLabel(item) }}</Badge>
      <Badge :variant="item.content_source === 'user_explicit' ? 'default' : 'outline'" data-item-source>
        {{ sourceLabel(item) }}
      </Badge>
      <Badge :variant="item.confirmation_status === 'pending' ? 'warning' : 'success'" data-item-confirmation>
        {{ confirmationLabel(item) }}
      </Badge>
    </div>
    <dl class="m-0 grid gap-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt class="text-muted-foreground">{{ t('knowledgeQuickEdit.scope.title') }}</dt>
      <dd class="m-0 flex flex-wrap items-center gap-1.5" data-item-scope>
        <span class="break-words">{{ scopeLabel(item.scope) }}</span>
        <Badge v-if="item.scope.status === 'undetermined'" variant="warning" data-scope-undetermined>
          {{ t('knowledgeQuickEdit.scope.undetermined') }}
        </Badge>
      </dd>
      <dt class="text-muted-foreground">{{ t('knowledgeQuickEdit.weight.title') }}</dt>
      <dd class="m-0 grid gap-0.5" data-item-weight>
        <template v-if="item.weight">
          <UiWeight :percent="item.weight.percent" :confirmed-by-person="item.weight.basis.confirmed_by_person"
            :label="t('knowledgeQuickEdit.weight.title')" />
          <span class="text-xs text-muted-foreground">{{ weightBasisLabel(item.weight) }}</span>
          <span class="text-xs text-muted-foreground">{{ t('knowledgeQuickEdit.weight.note') }}</span>
        </template>
        <span v-else>{{ t('knowledgeQuickEdit.weight.none') }}</span>
      </dd>
      <dt class="text-muted-foreground">{{ t('knowledgeQuickEdit.tags.title') }}</dt>
      <dd class="m-0 flex flex-wrap gap-1.5" data-item-tags>
        <Badge v-for="tag in item.tags" :key="tag.id" variant="outline" :title="tag.name">#{{ tag.name }}</Badge>
        <span v-if="!item.tags.length" class="text-muted-foreground">{{ t('knowledgeQuickEdit.tags.none') }}</span>
      </dd>
    </dl>
    <p v-if="item.scope.status === 'undetermined'" class="m-0 text-xs text-muted-foreground">
      {{ t('knowledgeQuickEdit.scope.undeterminedHelp') }}
    </p>
  </Card>
</template>
