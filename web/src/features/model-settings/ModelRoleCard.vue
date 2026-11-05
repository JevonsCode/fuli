<script setup lang="ts">
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import ModelUseCard from './ModelUseCard.vue'
import SemanticIndexProgress from './SemanticIndexProgress.vue'
import { roleName, SEMANTIC_ROLE, type ModelRoleView } from './model'
import { stateTone, useAdvice } from './model-uses'
import { needsPerson } from './role-details'

// A role as a use card: a built-in Agent, or 语义搜索 (rec#88), the person's
// own model that finds knowledge by meaning, shown wide with its index
// progress. Without a model the card says who answers instead and its action
// is 接入; the long facts, trust and history open in 「查看详情」.
const props = defineProps<{ view: ModelRoleView; locked: boolean; editing: boolean }>()
const emit = defineEmits<{ edit: []; details: [] }>()

const semantic = computed(() => props.view.role === SEMANTIC_ROLE)
const name = computed(() => roleName(props.view.role))
const connected = computed(() => Boolean(props.view.connection))
const waiting = computed(() => needsPerson(props.view))
</script>

<template>
  <ModelUseCard :name="name" :state="t(`modelSettings.states.${view.state}`)" :tone="stateTone(view.state)"
    :advice="useAdvice(view.role)" :lifted="editing || waiting" :wide="semantic"
    :data-model-role="view.role" :data-semantic-search="semantic || undefined" :data-model-needs-person="waiting || undefined">
    <template #model>
      <template v-if="view.connection">
        <code data-model-role-model>{{ view.connection.model }}</code>
        <span :title="view.connection.endpointHost">{{ view.connection.endpointHost }}</span>
      </template>
      <span v-else data-model-role-unconnected>{{ t(semantic ? 'modelSettings.uses.noModelSemantic' : 'modelSettings.uses.noModel') }}</span>
    </template>
    <p v-if="waiting && view.state !== 'invalid_config'" class="model-role-waiting" data-model-role-waiting>{{ t('modelSettings.uses.waiting') }}</p>
    <SemanticIndexProgress v-if="semantic" :model="view.state === 'enabled' ? view.connection?.model ?? null : null" />
    <template #actions>
      <Button variant="ghost" size="sm" :aria-label="`${t('modelSettings.uses.details')} ${name}`" data-model-role-details @click="emit('details')">
        {{ t('modelSettings.uses.details') }}
      </Button>
      <Button :variant="connected ? 'outline' : 'default'" size="sm" :disabled="locked" data-model-role-edit
        :aria-label="`${t(connected ? 'modelSettings.edit' : 'modelSettings.uses.connect')} ${name}`" @click="emit('edit')">
        {{ t(connected ? 'modelSettings.edit' : 'modelSettings.uses.connect') }}
      </Button>
    </template>
  </ModelUseCard>
</template>

<style scoped>
.model-role-waiting { margin: 0; color: var(--color-warning); font-size: var(--text-control); line-height: 20px; }
</style>
