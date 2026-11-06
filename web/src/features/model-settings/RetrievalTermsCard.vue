<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { OptionCombobox } from '@/components/ui/combobox'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import ModelUseCard from './ModelUseCard.vue'
import type { ModelRoleView } from './model'
import { stateTone, useAdvice } from './model-uses'
import { fillTerms, readTerms, stopTerms, trialTerms, type TermsState, type TermsTrial } from './retrieval-terms'

// Old knowledge was saved with its own words only (rec#92). Counting what lacks
// retrieval terms is free; a self-test on 20 items measures with real searches
// how many more are found and what an item costs; then the person fills the
// rest of the project, or not. A fill runs in the background and can stop.
// A use card on Astro's model: without the switch its action opens Astro's settings.
const props = withDefaults(defineProps<{ projects: readonly PersonalProject[]; status?: ModelRoleView['state']; model?: string | null }>(),
  { status: 'not_configured', model: null })
const emit = defineEmits<{ edit: [] }>()

const projectId = ref('')
const state = ref<TermsState | null>(null)
const testing = ref(false)
const declined = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let unmounted = false

const choices = computed(() => props.projects.filter(project => project.scope_type !== 'temporary')
  .map(project => ({ value: project.project_id, label: project.profile.name })))
const projectName = computed(() => choices.value.find(choice => choice.value === projectId.value)?.label ?? projectId.value)
// Without Astro's model, or with the task off in its settings, the action opens those settings.
const needsAstro = computed(() => state.value?.readiness === 'needs_model' || state.value?.readiness === 'not_allowed')
const ready = computed(() => state.value?.readiness === 'ready')
const filling = computed(() => state.value?.run?.status === 'running')
const busyElsewhere = computed(() => Boolean(state.value?.busy && state.value.busy.personalProjectId !== projectId.value))
const trial = computed<TermsTrial | null>(() => (declined.value ? null : state.value?.trial ?? null))
const missing = computed(() => state.value?.stats?.missing ?? 0)
const note = computed(() => {
  const readiness = state.value?.readiness
  // Without Astro's model the model line already says so.
  if (readiness === 'needs_model') return props.model ? t('modelSettings.retrievalTerms.needsModel') : ''
  if (readiness === 'not_allowed') return t('modelSettings.retrievalTerms.notAllowed')
  if (readiness === 'project_not_approved') return t('modelSettings.retrievalTerms.notApproved')
  return ''
})

watch(choices, (next) => { if (!projectId.value && next[0]) projectId.value = next[0].value }, { immediate: true })
watch(projectId, () => { declined.value = false; void load() }, { immediate: true })
onBeforeUnmount(() => { unmounted = true; clearTimeout(timer) })

async function load() {
  clearTimeout(timer)
  if (!projectId.value) return
  try {
    state.value = await readTerms(projectId.value)
  } catch (cause) {
    error.value = apiErrorReason(cause)
  }
  if (!unmounted && filling.value) timer = setTimeout(load, 3000)
}

async function act(action: () => Promise<unknown>) {
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = apiErrorReason(cause)
  }
  await load()
}

async function test() {
  testing.value = true
  declined.value = false
  await act(() => trialTerms(projectId.value))
  testing.value = false
}

const fill = () => act(() => fillTerms(projectId.value))
const stop = () => act(stopTerms)
</script>

<template>
  <ModelUseCard :name="t('modelSettings.retrievalTerms.title')" :state="t(`modelSettings.uses.taskStates.${status}`)" :tone="stateTone(status)"
    :advice="useAdvice('retrieval_terms')" data-retrieval-terms>
    <template #model>
      <template v-if="model"><code>{{ model }}</code><span>{{ t('modelSettings.uses.astroModel') }}</span></template>
      <span v-else>{{ t('modelSettings.uses.astroNoModel') }}</span>
    </template>

    <GrowthLoading v-if="!state && projectId && !error" variant="compact" :label="t('modelSettings.retrievalTerms.loading')" />
    <p v-else-if="note" class="terms-note" data-terms-note>{{ note }}</p>
    <template v-else-if="state?.stats">
      <p v-if="filling" class="terms-note" role="status" data-terms-filling>
        {{ t('modelSettings.retrievalTerms.filling', { written: state.run?.written ?? 0, total: missing + (state.run?.written ?? 0), tokens: state.run?.tokens ?? 0 }) }}
      </p>
      <p v-else-if="!missing" class="terms-note" data-terms-complete>{{ t('modelSettings.retrievalTerms.complete', { count: state.stats.items }) }}</p>
      <template v-else>
        <div v-if="trial?.status === 'tested'" class="terms-trial" data-terms-trial>
          <p class="terms-result">
            {{ t('modelSettings.retrievalTerms.result', { sample: trial.sample ?? 0, before: trial.before ?? 0, after: trial.after ?? 0 }) }}
            <strong :data-advice="trial.advice">{{ t(`modelSettings.retrievalTerms.advice.${trial.advice ?? 'not_worth'}`) }}</strong>
          </p>
          <p class="terms-note">
            {{ t('modelSettings.retrievalTerms.cost', { perItem: trial.tokens?.perItem ?? 0, remaining: missing, projected: (trial.tokens?.perItem ?? 0) * missing }) }}
          </p>
          <div class="terms-choice">
            <Button size="sm" :variant="trial.advice === 'fill' ? 'default' : 'outline'" :disabled="busyElsewhere" data-terms-fill @click="fill">
              {{ t('modelSettings.retrievalTerms.fill', { count: missing }) }}
            </Button>
            <Button size="sm" variant="ghost" data-terms-decline @click="declined = true">{{ t('modelSettings.retrievalTerms.decline') }}</Button>
          </div>
        </div>
        <p v-else class="terms-note" data-terms-missing>
          {{ t('modelSettings.retrievalTerms.missing', { count: missing, tokens: state.stats.roughTokens }) }}
        </p>
        <p v-if="state.run && state.run.status !== 'running'" class="terms-note" data-terms-last-run>
          {{ t(`modelSettings.retrievalTerms.run.${state.run.status}`, { written: state.run.written ?? 0, tokens: state.run.tokens ?? 0 }) }}
        </p>
      </template>
    </template>
    <p v-if="error" role="alert" class="terms-error">{{ error }}</p>
    <template #actions>
      <OptionCombobox v-if="!needsAstro" v-model="projectId" class="terms-project" size="sm" :options="choices" :label="t('modelSettings.retrievalTerms.project')" data-terms-project />
      <Button v-if="needsAstro" size="sm" variant="outline" data-terms-open @click="emit('edit')">
        {{ t('modelSettings.uses.openAstro') }}
      </Button>
      <Button v-else-if="filling" size="sm" variant="outline" data-terms-stop @click="stop">
        {{ t('modelSettings.retrievalTerms.stop') }}
      </Button>
      <Button v-else size="sm" :variant="trial ? 'outline' : 'default'" :disabled="!ready || !missing || busyElsewhere"
        :loading="testing" :loading-label="t('modelSettings.retrievalTerms.testing', { name: projectName })"
        data-terms-test @click="test">
        {{ t('modelSettings.retrievalTerms.test') }}
      </Button>
    </template>
  </ModelUseCard>
</template>

<style scoped>
.terms-note { margin: 0; color: var(--color-muted); font-size: var(--text-control); }
.terms-trial { display: grid; gap: 8px; }
.terms-result { margin: 0; font-size: var(--text-body); font-variant-numeric: tabular-nums; }
.terms-result strong { margin-left: 8px; color: var(--color-muted); font-weight: var(--weight-strong); }
.terms-result strong[data-advice="fill"] { color: var(--color-gold); }
.terms-choice { display: flex; gap: 8px; }
.terms-error { margin: 0; color: var(--color-danger); font-size: var(--text-control); }
.terms-project { flex: 1; min-width: 0; }
</style>
