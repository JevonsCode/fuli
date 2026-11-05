<script setup lang="ts">
import { computed } from 'vue'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { t } from '@/i18n'
import ModelRoleCheck from './ModelRoleCheck.vue'
import SemanticIndexProgress from './SemanticIndexProgress.vue'
import { SEMANTIC_ROLE, type ModelRoleView } from './model'

// 语义搜索 (rec#88): the person's own model that lets FULI find knowledge by
// meaning. Without it FULI matches words only. Its settings open in the same
// dialog as a built-in Agent's; its test reports the vector length.
const props = defineProps<{ view: ModelRoleView | undefined; locked: boolean }>()
const emit = defineEmits<{ edit: [] }>()

const state = computed(() => props.view?.state ?? 'not_configured')
const tone = computed(() => (state.value === 'enabled' ? 'success' : state.value === 'invalid_config' ? 'warning' : 'secondary'))
</script>

<template>
  <Card as="section" class="semantic-card" aria-labelledby="semantic-search-title" data-semantic-search>
    <CardHeader>
      <CardTitle id="semantic-search-title" as="h2">{{ t('modelSettings.semantic.title') }}</CardTitle>
      <CardDescription class="semantic-summary">{{ t('modelSettings.semantic.summary') }}</CardDescription>
    </CardHeader>
    <div class="semantic-body">
      <p class="semantic-line" data-semantic-connection>
        <Badge :variant="tone" data-semantic-state>{{ t(`modelSettings.states.${state}`) }}</Badge>
        <template v-if="view?.connection">
          <code>{{ view.connection.model }}</code>
          <span>{{ view.connection.endpointHost }}</span>
        </template>
      </p>
      <SemanticIndexProgress :model="view?.state === 'enabled' ? view.connection?.model ?? null : null" />
      <footer class="semantic-actions">
        <ModelRoleCheck v-if="view?.connection" :role="SEMANTIC_ROLE" :model="view.connection.model" />
        <Button variant="outline" size="sm" :disabled="locked" data-semantic-edit
          :aria-label="`${t('modelSettings.edit')} ${t('modelSettings.semantic.title')}`" @click="emit('edit')">
          {{ t('modelSettings.edit') }}
        </Button>
      </footer>
    </div>
  </Card>
</template>

<style scoped>
.semantic-summary { font-size: var(--text-body); }
.semantic-body { display: grid; gap: 12px; padding-inline: 20px; }
.semantic-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; margin: 0; color: var(--color-muted); font-size: 13px; }
.semantic-line code { color: var(--color-ink); font-family: var(--font-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.semantic-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
</style>
