<script setup lang="ts">
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import ModelFailureNote from './ModelFailureNote.vue'
import ModelUseCard from './ModelUseCard.vue'
import SemanticIndexProgress from './SemanticIndexProgress.vue'
import { roleName, SEMANTIC_ROLE, type ModelRoleView } from './model'
import { healthLine, isFailing } from './model-health'
import { stateTone, useAdvice } from './model-uses'
import { needsPerson } from './role-details'

// A role as a use card: a built-in Agent, or 语义搜索 (rec#88), the person's
// own model that finds knowledge by meaning, shown wide with its index
// progress. Its one line says how it stands now: without a model, what model
// is enough (and the action is 接入); with one, whether its latest call
// answered. A model that did not answer says why, with 「测试连接」 in the line.
// The long facts, trust and history open in 「查看详情」.
const props = defineProps<{ view: ModelRoleView; locked: boolean; editing: boolean }>()
const emit = defineEmits<{ edit: []; details: []; checked: [] }>()

const semantic = computed(() => props.view.role === SEMANTIC_ROLE)
const name = computed(() => roleName(props.view.role))
const connection = computed(() => props.view.connection ?? null)
const waiting = computed(() => needsPerson(props.view))
// Only a use that is on can fail: one that is off makes no calls.
const failing = computed(() => props.view.state === 'enabled' && isFailing(props.view.health))
const health = computed(() => healthLine(props.view.health, currentLocale()))
</script>

<template>
  <ModelUseCard :name="name" :state="failing ? t('modelSettings.health.failingState') : t(`modelSettings.states.${view.state}`)"
    :tone="failing ? 'destructive' : stateTone(view.state)" :lifted="editing || waiting || failing" :wide="semantic"
    :data-model-role="view.role" :data-semantic-search="semantic || undefined" :data-model-needs-person="waiting || undefined"
    :data-model-failing="failing || undefined">
    <template #model>
      <template v-if="connection">
        <code data-model-role-model>{{ connection.model }}</code>
        <span :title="connection.endpointHost">{{ connection.endpointHost }}</span>
      </template>
      <span v-else data-model-role-unconnected>{{ t(semantic ? 'modelSettings.uses.noModelSemantic' : 'modelSettings.uses.noModel') }}</span>
    </template>
    <ModelFailureNote v-if="failing && connection" :text="health" :role="view.role" :model="connection.model" @checked="emit('checked')" />
    <p v-else-if="waiting && view.state !== 'invalid_config'" class="model-role-waiting" data-model-role-waiting>{{ t('modelSettings.uses.waiting') }}</p>
    <p v-else-if="!connection" class="model-role-advice" :title="useAdvice(view.role)" data-model-use-advice>
      <span class="model-role-label">{{ t('modelSettings.uses.advicePrefix') }}</span>{{ useAdvice(view.role) }}
    </p>
    <p v-else-if="view.state === 'enabled'" class="model-role-health" data-model-role-health>{{ health }}</p>
    <SemanticIndexProgress v-if="semantic" :model="view.state === 'enabled' ? connection?.model ?? null : null" />
    <template #actions>
      <Button variant="ghost" size="sm" :aria-label="`${t('modelSettings.uses.details')} ${name}`" data-model-role-details @click="emit('details')">
        {{ t('modelSettings.uses.details') }}
      </Button>
      <Button :variant="connection ? 'outline' : 'default'" size="sm" :disabled="locked" data-model-role-edit
        :aria-label="`${t(connection ? 'modelSettings.edit' : 'modelSettings.uses.connect')} ${name}`" @click="emit('edit')">
        {{ t(connection ? 'modelSettings.edit' : 'modelSettings.uses.connect') }}
      </Button>
    </template>
  </ModelUseCard>
</template>

<style scoped>
.model-role-waiting { color: var(--color-warning); }
.model-role-health { overflow: hidden; color: var(--color-muted); text-overflow: ellipsis; white-space: nowrap; }
/* The whole recommendation shows in two lines; a longer one keeps its full text in a title. */
.model-role-advice { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
.model-role-label { margin-inline-end: 8px; color: var(--color-muted); font-size: var(--text-meta); }
</style>
