<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { OptionCombobox } from '@/components/ui/combobox'
import { t } from '@/i18n'
import { UiDialog } from '@/ui'
import ModelFailureNote from './ModelFailureNote.vue'
import { useAdvice } from './model-uses'
import type { RetrievalTerms } from './useRetrievalTerms'

// 「查看详情」 of 补检索词 (11-11): the project choice, how it stands, what the
// 20-item self-test measured with its cost and advice, and the fill of the
// rest or not. A fill the model stopped answering says so with 「测试连接」 and
// 「重试」. The actions keep their place in the footer.
defineProps<{ open: boolean; terms: RetrievalTerms; model: string | null }>()
const emit = defineEmits<{ close: []; checked: [] }>()
</script>

<template>
  <UiDialog :open="open" :title="t('modelSettings.retrievalTerms.title')" size="md" data-terms-dialog @close="emit('close')">
    <div class="terms-dialog">
      <p class="terms-line" data-terms-advice><span class="terms-label">{{ t('modelSettings.uses.advicePrefix') }}</span>{{ useAdvice('retrieval_terms') }}</p>
      <OptionCombobox :model-value="terms.projectId" :options="terms.choices" :label="t('modelSettings.retrievalTerms.project')" data-terms-project @update:model-value="terms.choose(String($event))" />
      <p v-if="terms.error" role="alert" class="terms-line is-failed" data-terms-error>{{ terms.error }}</p>
      <p v-else-if="terms.note" class="terms-line" data-terms-note>{{ terms.note }}</p>
      <template v-else-if="terms.state?.stats">
        <ModelFailureNote v-if="terms.failed" :text="terms.line" role="assistant" :model="model ?? ''" @checked="emit('checked')" />
        <p v-else class="terms-line" :role="terms.filling ? 'status' : undefined" data-terms-line>{{ terms.line }}</p>
        <p v-if="terms.lastRun && terms.missing && !terms.failed" class="terms-line" data-terms-last-run>{{ terms.lastRun }}</p>
        <div v-if="terms.trial?.status === 'tested' && terms.missing && !terms.filling" class="terms-trial" data-terms-trial>
          <p class="terms-result">
            {{ t('modelSettings.retrievalTerms.result', { sample: terms.trial.sample ?? 0, before: terms.trial.before ?? 0, after: terms.trial.after ?? 0 }) }}
            <strong :data-advice="terms.trial.advice">{{ t(`modelSettings.retrievalTerms.advice.${terms.trial.advice ?? 'not_worth'}`) }}</strong>
          </p>
          <p class="terms-line">
            {{ t('modelSettings.retrievalTerms.cost', { perItem: terms.trial.tokens?.perItem ?? 0, remaining: terms.missing, projected: (terms.trial.tokens?.perItem ?? 0) * terms.missing }) }}
          </p>
        </div>
      </template>
    </div>
    <template #footer>
      <template v-if="terms.trial?.status === 'tested' && terms.missing && !terms.filling && !terms.failed">
        <Button size="sm" variant="ghost" data-terms-decline @click="terms.decline()">{{ t('modelSettings.retrievalTerms.decline') }}</Button>
        <Button size="sm" :variant="terms.trial.advice === 'fill' ? 'default' : 'outline'" :disabled="terms.busyElsewhere" data-terms-fill @click="terms.fill()">
          {{ t('modelSettings.retrievalTerms.fill', { count: terms.missing }) }}
        </Button>
      </template>
      <Button v-else-if="terms.filling" size="sm" variant="outline" data-terms-stop @click="terms.stop()">{{ t('modelSettings.retrievalTerms.stop') }}</Button>
      <Button v-else-if="terms.failed" size="sm" :disabled="terms.busyElsewhere" data-terms-retry @click="terms.fill()">{{ t('modelSettings.retryAction') }}</Button>
      <Button v-else size="sm" :disabled="!terms.ready || !terms.missing || terms.busyElsewhere"
        :loading="terms.testing" :loading-label="t('modelSettings.retrievalTerms.testing', { name: terms.projectName })" data-terms-test @click="terms.test()">
        {{ t('modelSettings.retrievalTerms.test') }}
      </Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.terms-dialog { display: grid; gap: var(--space-3); min-width: 0; }
.terms-line { margin: 0; color: var(--color-muted); font-size: var(--text-control); }
.terms-label { margin-inline-end: 8px; font-size: var(--text-meta); }
.terms-line.is-failed { color: var(--color-danger); }
.terms-trial { display: grid; gap: 8px; }
.terms-result { margin: 0; font-size: var(--text-body); font-variant-numeric: tabular-nums; }
.terms-result strong { margin-left: 8px; color: var(--color-muted); font-weight: var(--weight-strong); }
.terms-result strong[data-advice="fill"] { color: var(--color-gold); }
</style>
