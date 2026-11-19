<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { OptionCombobox } from '@/components/ui/combobox'
import { t } from '@/i18n'
import { UiDialog } from '@/ui'
import ModelFailureNote from './ModelFailureNote.vue'
import UseSteps from './UseSteps.vue'
import { useAdvice } from './model-uses'
import type { RetrievalTerms } from './useRetrievalTerms'

// 「查看详情」 of 补检索词 (11-11): the project choice, then how filling works
// in three steps, shown also for a project not yet approved (all still to
// come until it is counted), each with what the server answered of it (rec issue 143): the
// count, what the 20-item self-test measured or why it stopped, and the fill's
// written of total. Under them the advice and the cost of the rest, for the
// choice to fill it or not. A fill the model stopped answering says so with
// 「测试连接」 and 「重试」; a project not approved has 「去授权」. The
// actions keep their place in the footer.
defineProps<{ open: boolean; terms: RetrievalTerms; model: string | null }>()
const emit = defineEmits<{ close: []; authorize: []; checked: [] }>()
</script>

<template>
  <UiDialog :open="open" :title="t('modelSettings.retrievalTerms.title')" size="md" data-terms-dialog @close="emit('close')">
    <div class="terms-dialog">
      <p class="terms-line" data-terms-advice><span class="terms-label">{{ t('modelSettings.uses.advicePrefix') }}</span>{{ useAdvice('retrieval_terms') }}</p>
      <OptionCombobox :model-value="terms.projectId" :options="terms.choices" :label="t('modelSettings.retrievalTerms.project')" data-terms-project @update:model-value="terms.choose(String($event))" />
      <p v-if="terms.error" role="alert" class="terms-line is-error" data-terms-error>{{ terms.error }}</p>
      <p v-else-if="terms.note" class="terms-line" data-terms-note>{{ terms.note }}</p>
      <template v-else-if="terms.state?.stats">
        <ModelFailureNote v-if="terms.failed" :text="terms.line" role="assistant" :model="model ?? ''" @checked="emit('checked')" />
        <ModelFailureNote v-else-if="terms.trialFailure?.model" :text="t('modelSettings.retrievalTerms.trialStopped', { reason: terms.trialFailure.text })" role="assistant"
          :model="model ?? ''" @checked="emit('checked')" />
      </template>
      <!-- Also before a project is approved: how filling works is read before agreeing to send anything. -->
      <UseSteps v-if="!terms.error" :steps="terms.steps" :label="t('modelSettings.retrievalTerms.stepsLabel')" />
      <div v-if="terms.tested && terms.trial && !terms.note" class="terms-trial" data-terms-trial>
        <p class="terms-result">
          {{ t('modelSettings.retrievalTerms.result', { sample: terms.trial.sample ?? 0, before: terms.trial.before ?? 0, after: terms.trial.after ?? 0 }) }}
          <strong :data-advice="terms.trial.advice">{{ t(`modelSettings.retrievalTerms.advice.${terms.trial.advice ?? 'not_worth'}`) }}</strong>
        </p>
        <p class="terms-line">
          {{ t('modelSettings.retrievalTerms.cost', { perItem: terms.trial.tokens?.perItem ?? 0, remaining: terms.missing, projected: (terms.trial.tokens?.perItem ?? 0) * terms.missing }) }}
        </p>
      </div>
    </div>
    <template #footer>
      <Button v-if="terms.needsApproval" size="sm" data-terms-authorize @click="emit('authorize')">{{ t('modelSettings.uses.authorize') }}</Button>
      <template v-else-if="terms.tested">
        <Button size="sm" variant="ghost" data-terms-decline @click="terms.decline()">{{ t('modelSettings.retrievalTerms.decline') }}</Button>
        <Button size="sm" :variant="terms.trial?.advice === 'fill' ? 'default' : 'outline'" :disabled="terms.busyElsewhere" data-terms-fill @click="terms.fill()">
          {{ t('modelSettings.retrievalTerms.fill', { count: terms.missing }) }}
        </Button>
      </template>
      <Button v-else-if="terms.filling" size="sm" variant="outline" data-terms-stop @click="terms.stop()">{{ t('modelSettings.retrievalTerms.stop') }}</Button>
      <Button v-else-if="terms.failed" size="sm" :disabled="terms.busyElsewhere" data-terms-retry @click="terms.fill()">{{ t('modelSettings.retryAction') }}</Button>
      <Button v-else size="sm" :disabled="!terms.ready || !terms.missing || terms.busyElsewhere"
        :loading="terms.testing" :loading-label="t('modelSettings.retrievalTerms.testing', { name: terms.projectName })" data-terms-test @click="terms.test()">
        {{ terms.trialFailure ? t('modelSettings.retryAction') : t('modelSettings.retrievalTerms.test') }}
      </Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.terms-dialog { display: grid; gap: var(--space-4); min-width: 0; }
.terms-line { margin: 0; color: var(--color-muted); font-size: var(--text-control); }
.terms-label { margin-inline-end: 8px; font-size: var(--text-meta); }
.terms-line.is-error { color: var(--color-danger); }
.terms-trial { display: grid; gap: 8px; }
.terms-result { margin: 0; font-size: var(--text-body); font-variant-numeric: tabular-nums; }
.terms-result strong { margin-left: 8px; color: var(--color-muted); font-weight: var(--weight-strong); }
.terms-result strong[data-advice="fill"] { color: var(--color-gold); }
</style>
