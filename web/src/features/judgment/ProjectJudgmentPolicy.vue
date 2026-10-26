<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'

import JudgmentPolicyControls from './JudgmentPolicyControls.vue'
import { judgmentText, policySummary } from './judgment-copy'
import { loadJudgmentPolicy, saveJudgmentPolicy, startProjectJudgmentPolicy } from './judgment-api'
import { normalizeJudgmentPolicy, policySelection, type JudgmentPolicy, type JudgmentPolicySelection } from './judgment-types'

// One project's Tonborg judgment: the default it uses, or its own policy,
// which the person changes or removes to use the default again. The project
// page shows it under its own heading; Tonborg's workbench lists one per
// project that has its own, named by the project and already read (policy).
const props = defineProps<{
  personalSpaceId: string
  projectId: string
  projectName: string
  heading: string
  policy?: JudgmentPolicy
}>()
const emit = defineEmits<{ change: [JudgmentPolicy] }>()

type Pending = 'loading' | 'starting' | 'saving' | 'resetting'
const policy = ref<JudgmentPolicy | null>(props.policy ?? null)
const pending = ref<Pending | null>(null)
const error = ref('')
let generation = 0

const busy = computed(() => pending.value !== null)
const pendingLabel = computed(() => pending.value ? t(`judgment.project.${pending.value}`, { name: props.projectName }) : '')

if (!props.policy) void load()
watch(() => [props.personalSpaceId, props.projectId], () => { void load() })

async function load() {
  const current = ++generation
  error.value = ''
  pending.value = 'loading'
  try {
    const value = normalizeJudgmentPolicy(await loadJudgmentPolicy(props.personalSpaceId, props.projectId))
    if (current === generation) policy.value = value
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : judgmentText('settings.loadError')
  } finally {
    if (current === generation) pending.value = null
  }
}

function statusCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'status' in cause ? (cause as { status?: unknown }).status : null
}

async function write(kind: Exclude<Pending, 'loading'>, request: () => Promise<JudgmentPolicy>) {
  if (busy.value) return
  const current = ++generation
  error.value = ''
  pending.value = kind
  try {
    const value = normalizeJudgmentPolicy(await request())
    if (current !== generation) return
    policy.value = value
    emit('change', value)
  } catch (cause) {
    if (current !== generation) return
    if (statusCode(cause) === 409) {
      await load()
      error.value = judgmentText('settings.conflictError')
    } else error.value = cause instanceof Error ? cause.message : judgmentText('settings.saveError')
  } finally {
    if (current === generation) pending.value = null
  }
}

function start() {
  return write('starting', () => startProjectJudgmentPolicy(props.personalSpaceId, props.projectId))
}

function save(next: JudgmentPolicySelection) {
  const revision = policy.value?.revision ?? 0
  return write('saving', () => saveJudgmentPolicy(props.personalSpaceId, props.projectId, next, revision))
}

function reset() {
  const revision = policy.value?.revision ?? 0
  return write('resetting', () => saveJudgmentPolicy(props.personalSpaceId, props.projectId, null, revision))
}
</script>

<template>
  <section class="project-judgment-policy" :data-project-judgment="projectId" :data-inherited="policy?.inherited">
    <strong class="project-judgment-heading">{{ heading }}</strong>
    <GrowthLoading v-if="pending === 'loading'" variant="inline" :label="pendingLabel" />
    <template v-else-if="policy">
      <div v-if="policy.inherited" class="project-judgment-row">
        <span class="project-judgment-default" data-project-judgment-default>{{ t('judgment.project.usesDefault', { policy: policySummary(policy) }) }}</span>
        <Button size="sm" variant="outline" data-action="start-project-policy" :disabled="busy" :loading="pending === 'starting'" :loading-label="pendingLabel" @click="start">
          {{ judgmentText('project.start') }}
        </Button>
      </div>
      <div v-else class="project-judgment-row">
        <JudgmentPolicyControls class="project-judgment-controls" :model-value="policySelection(policy)" :disabled="busy" @update:model-value="save" />
        <Button size="sm" variant="ghost" data-action="reset-project-policy" :disabled="busy" :loading="pending === 'resetting'" :loading-label="pendingLabel" @click="reset">
          {{ judgmentText('project.reset') }}
        </Button>
      </div>
      <GrowthLoading v-if="pending === 'saving'" variant="inline" data-project-judgment-saving :label="pendingLabel" />
    </template>
    <p v-if="error" class="project-judgment-error" role="alert">
      <span>{{ error }}</span>
      <Button v-if="!policy" size="sm" variant="ghost" @click="load">{{ judgmentText('settings.retry') }}</Button>
    </p>
  </section>
</template>

<style scoped>
.project-judgment-policy { display: grid; gap: 8px; min-width: 0; }
.project-judgment-heading { color: var(--color-ink); font-size: 14px; font-weight: 550; }
.project-judgment-row { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 10px; }
.project-judgment-controls { flex: 1 1 320px; }
.project-judgment-default { color: var(--color-muted); font-size: 13px; line-height: 1.5; }
.project-judgment-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0; color: var(--color-danger); font-size: 12px; }
</style>
