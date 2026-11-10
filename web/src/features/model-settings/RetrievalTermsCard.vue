<script setup lang="ts">
import { computed, ref } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import ModelFailureNote from './ModelFailureNote.vue'
import ModelUseCard from './ModelUseCard.vue'
import RetrievalTermsDialog from './RetrievalTermsDialog.vue'
import type { ModelRoleView } from './model'
import { stateTone } from './model-uses'
import { useRetrievalTerms } from './useRetrievalTerms'

// Old knowledge was saved with its own words only (rec#92). A compact use card
// on Astro's model (11-11): one line of how the first project stands and one
// action in one place: 「先试 20 条」 (its result opens in the details), 「停止」
// while a fill runs, 「重试」 after one the model stopped answering, or Astro's
// settings without the switch. The project choice, the measured gain, the cost
// and the fill open in 「查看详情」.
const props = withDefaults(defineProps<{ projects: readonly PersonalProject[]; status?: ModelRoleView['state']; model?: string | null }>(),
  { status: 'not_configured', model: null })
const emit = defineEmits<{ edit: []; checked: [] }>()

const terms = useRetrievalTerms(() => props.projects, () => props.model)
const details = ref(false)
const title = computed(() => t('modelSettings.retrievalTerms.title'))
const summary = computed(() => (terms.line ? `${terms.projectName} · ${terms.line}` : ''))

async function test() {
  await terms.test()
  if (!terms.error) details.value = true
}

function openAstro() {
  details.value = false
  emit('edit')
}
</script>

<template>
  <ModelUseCard :name="title" :state="t(`modelSettings.uses.taskStates.${status}`)" :tone="stateTone(status)" :lifted="terms.failed" data-retrieval-terms>
    <template #model>
      <template v-if="model"><code>{{ model }}</code><span>{{ t('modelSettings.uses.astroModel') }}</span></template>
      <span v-else>{{ t('modelSettings.uses.astroNoModel') }}</span>
    </template>

    <p v-if="terms.error" role="alert" class="terms-note is-error" :title="terms.error" data-terms-error>{{ terms.error }}</p>
    <GrowthLoading v-else-if="!terms.state && terms.projectId" variant="inline" :label="t('modelSettings.retrievalTerms.loading')" />
    <p v-else-if="terms.note" class="terms-note" data-terms-note>{{ terms.note }}</p>
    <ModelFailureNote v-else-if="terms.failed" :text="summary" role="assistant" :model="model ?? ''" data-terms-failed @checked="emit('checked')" />
    <p v-else-if="summary" class="terms-note" :role="terms.filling ? 'status' : undefined" :title="summary" data-terms-summary>{{ summary }}</p>
    <template #actions>
      <Button v-if="terms.state && !terms.needsAstro" variant="ghost" size="sm" :aria-label="`${t('modelSettings.uses.details')} ${title}`"
        data-terms-details @click="details = true">
        {{ t('modelSettings.uses.details') }}
      </Button>
      <Button v-if="terms.needsAstro" size="sm" variant="outline" data-terms-open @click="openAstro">
        {{ t('modelSettings.uses.openAstro') }}
      </Button>
      <Button v-else-if="terms.error" size="sm" variant="outline" data-terms-reload @click="terms.load()">{{ t('modelSettings.retryAction') }}</Button>
      <Button v-else-if="terms.filling" size="sm" variant="outline" data-terms-stop @click="terms.stop()">
        {{ t('modelSettings.retrievalTerms.stop') }}
      </Button>
      <Button v-else-if="terms.failed" size="sm" :disabled="terms.busyElsewhere" data-terms-retry @click="terms.fill()">{{ t('modelSettings.retryAction') }}</Button>
      <Button v-else size="sm" :variant="terms.trial ? 'outline' : 'default'" :disabled="!terms.ready || !terms.missing || terms.busyElsewhere"
        :loading="terms.testing" :loading-label="t('modelSettings.retrievalTerms.testing', { name: terms.projectName })"
        data-terms-test @click="test">
        {{ t('modelSettings.retrievalTerms.test') }}
      </Button>
    </template>
  </ModelUseCard>
  <RetrievalTermsDialog :open="details" :terms="terms" :model="model" @close="details = false" @checked="emit('checked')" />
</template>

<style scoped>
.terms-note { color: var(--color-muted); }
.terms-note.is-error { color: var(--color-danger); }
</style>
