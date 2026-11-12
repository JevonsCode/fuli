<script setup lang="ts">
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import ModelFailureNote from './ModelFailureNote.vue'
import ModelUseCard from './ModelUseCard.vue'
import SemanticIndexProgress from './SemanticIndexProgress.vue'
import { BUILTIN_EMBEDDING_PROTOCOL, modelName, roleName, SEMANTIC_ROLE, type ModelRoleView } from './model'
import { failingState, healthLine, isFailing } from './model-health'
import { stateTone, useAdvice } from './model-uses'
import { needsPerson } from './role-details'

// An Agent without a model of its own is not broken: the current session's
// model answers when it is needed, so its state says 「用当前会话」, never 「未接」.
// 语义搜索 has no such fallback and stays 「未接」, with what that costs.
// A role as a use card: a built-in Agent, or 语义搜索 (rec#88), the person's
// own model that finds knowledge by meaning, shown wide with its index
// progress. Its one line says how it stands now: without a model, what model
// is enough (and the action is 接入); with one, whether its latest call
// answered. A model that did not answer says why, with 「测试连接」 in the line,
// and whether that is the shared connection or this role's own task (rec issue 122).
// The long facts, trust and history open in 「查看详情」.
const props = defineProps<{ view: ModelRoleView; locked: boolean; editing: boolean }>()
const emit = defineEmits<{ edit: []; details: []; checked: []; builtin: [] }>()

const semantic = computed(() => props.view.role === SEMANTIC_ROLE)
const name = computed(() => roleName(props.view.role))
const connection = computed(() => props.view.connection ?? null)
// A model FULI runs on this computer has no address worth showing; it is changed in 「内置模型」.
const builtin = computed(() => connection.value?.protocol === BUILTIN_EMBEDDING_PROTOCOL)
const waiting = computed(() => needsPerson(props.view))
// Only a use that is on can fail: one that is off makes no calls.
const failing = computed(() => props.view.state === 'enabled' && isFailing(props.view.health))
const health = computed(() => healthLine(props.view.health, currentLocale()))
const state = computed(() => (failing.value ? failingState(props.view.health)
  : props.view.state === 'not_configured' && !semantic.value ? t('modelSettings.uses.sessionState')
    : t(`modelSettings.states.${props.view.state}`)))
</script>

<template>
  <ModelUseCard :name="name" :state="state"
    :tone="failing ? 'destructive' : stateTone(view.state)" :lifted="editing || waiting || failing" :wide="semantic"
    :data-model-role="view.role" :data-semantic-search="semantic || undefined" :data-model-needs-person="waiting || undefined"
    :data-model-failing="failing || undefined">
    <template #model>
      <template v-if="connection">
        <code data-model-role-model>{{ modelName(connection) }}</code>
        <span v-if="builtin" data-model-role-builtin>{{ t('modelSettings.builtin.local') }}</span>
        <span v-else :title="connection.endpointHost">{{ connection.endpointHost }}</span>
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
      <Button v-if="!builtin" :variant="connection || semantic ? 'outline' : 'default'" size="sm" :disabled="locked" data-model-role-edit
        :aria-label="`${t(connection ? 'modelSettings.edit' : 'modelSettings.uses.connect')} ${name}`" @click="emit('edit')">
        {{ t(connection ? 'modelSettings.edit' : 'modelSettings.uses.connect') }}
      </Button>
      <Button v-if="semantic" :variant="connection ? 'outline' : 'default'" size="sm" :disabled="locked" data-model-role-builtin-open
        @click="emit('builtin')">
        {{ t('modelSettings.builtin.open') }}
      </Button>
    </template>
  </ModelUseCard>
</template>

<style scoped>
.model-role-waiting { color: var(--color-warning); }
.model-role-health { color: var(--color-muted); }
.model-role-label { margin-inline-end: 8px; color: var(--color-muted); font-size: var(--text-meta); }
</style>
