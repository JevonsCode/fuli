<script setup lang="ts">
import { t } from '@/i18n'
import type { SourceMemoryPreview } from './model'
import { sourceMemoryScopeLabel } from './source-delete-model'
defineProps<{ memory: SourceMemoryPreview; kind: 'episode' | 'session' }>()
</script>

<template>
  <div class="grid gap-2" data-source-memory>
    <p v-for="row in memory.scrubbed" :key="`${row.agent_id}:${row.personal_project_id}`" class="m-0 [overflow-wrap:anywhere]">
      {{ t(`knowledgeHardDelete.source.memory${kind === 'session' ? 'Session' : 'Episode'}`, { count: row.revisions.length,
        agent: sourceMemoryScopeLabel(row), current: row.current ? t('knowledgeHardDelete.source.memoryCurrent') : '' }) }}
    </p>
    <p v-if="!memory.scrubbed.length" class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.source.memoryNone') }}</p>
    <p class="m-0 text-muted-foreground" data-source-memory-limitation>{{ t('knowledgeHardDelete.source.memoryLimitation') }}</p>
  </div>
</template>
