<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import DreamingDialog from './DreamingDialog.vue'
import ModelFailureNote from './ModelFailureNote.vue'
import ModelUseCard from './ModelUseCard.vue'
import type { ModelRoleView } from './model'
import { stateTone } from './model-uses'
import { useDreaming } from './useDreaming'

// Dreaming, one of Astro's tasks, as a compact use card (11-11): one line of
// how it stands (how many projects have new sessions and when it last ran,
// what the runs just found, or what did not finish and why) and one action in
// one place: 整理全部, 重试 after a failure, or Astro's settings without a
// model. The projects, each with its own run, open in 「查看详情」.
const props = withDefaults(defineProps<{ status?: ModelRoleView['state']; model?: string | null }>(),
  { status: 'not_configured', model: null })
const emit = defineEmits<{ edit: []; checked: [] }>()

const dreaming = useDreaming()
const details = ref(false)
const listed = computed(() => dreaming.readiness === 'ready')
const runLabel = computed(() => (dreaming.running
  ? t(dreaming.running.fromStart ? 'modelSettings.dreaming.rereading' : 'modelSettings.dreaming.running', { name: dreaming.running.name }) : ''))

onMounted(() => void dreaming.load())

function openAstro() {
  details.value = false
  emit('edit')
}
</script>

<template>
  <ModelUseCard name="Dreaming" :state="t(`modelSettings.uses.taskStates.${status}`)" :tone="stateTone(status)"
    :lifted="dreaming.summary.kind === 'failed'" data-dreaming>
    <template #model>
      <template v-if="model"><code>{{ model }}</code><span>{{ t('modelSettings.uses.astroModel') }}</span></template>
      <span v-else>{{ t('modelSettings.uses.astroNoModel') }}</span>
    </template>
    <GrowthLoading v-if="dreaming.readiness === null" variant="inline" :label="t('modelSettings.dreaming.loading')" />
    <!-- Without Astro's model the model line already says so. -->
    <p v-else-if="dreaming.readiness === 'needs_model'" v-show="model" class="dreaming-note" data-dreaming-needs-model>{{ t('modelSettings.dreaming.needsModel') }}</p>
    <p v-else-if="dreaming.readiness === 'unavailable'" class="dreaming-note is-failed" role="alert" data-dreaming-unavailable>{{ t('modelSettings.dreaming.unavailable') }}</p>
    <ModelFailureNote v-else-if="dreaming.summary.kind === 'failed'" :text="dreaming.summary.text" role="assistant" :model="model ?? ''"
      data-dreaming-failed @checked="emit('checked')" />
    <p v-else class="dreaming-note" :title="dreaming.summary.text" data-dreaming-summary>
      {{ dreaming.summary.text }}
      <RouterLink v-if="dreaming.summary.kind === 'found' && dreaming.summary.queued > 0" to="/inbox" class="dreaming-confirm" data-dreaming-confirm>
        {{ t('modelSettings.dreaming.confirm') }}
      </RouterLink>
    </p>
    <template #actions>
      <Button v-if="listed" variant="ghost" size="sm" :aria-label="`${t('modelSettings.uses.details')} Dreaming`" data-dreaming-details @click="details = true">
        {{ t('modelSettings.uses.details') }}
      </Button>
      <Button v-if="dreaming.readiness === 'needs_model'" size="sm" variant="outline" data-dreaming-open @click="openAstro">
        {{ t('modelSettings.uses.openAstro') }}
      </Button>
      <Button v-else-if="dreaming.readiness === 'unavailable'" size="sm" variant="outline" data-dreaming-reload @click="dreaming.load()">
        {{ t('modelSettings.retryAction') }}
      </Button>
      <Button v-else-if="dreaming.failed.length" size="sm" :loading="dreaming.running !== null" :loading-label="runLabel" data-dreaming-retry @click="dreaming.retry()">
        {{ t('modelSettings.retryAction') }}
      </Button>
      <Button v-else-if="listed" size="sm" :variant="dreaming.pending.length ? 'default' : 'outline'" :disabled="!dreaming.pending.length"
        :loading="dreaming.running !== null" :loading-label="runLabel" data-dreaming-run-all @click="dreaming.runAll()">
        {{ t('modelSettings.dreaming.runAll') }}
      </Button>
    </template>
  </ModelUseCard>
  <DreamingDialog :open="details" :dreaming="dreaming" :model="model" @close="details = false" @edit="openAstro" @checked="emit('checked')" />
</template>

<style scoped>
.dreaming-note { color: var(--color-muted); }
.dreaming-note.is-failed { color: var(--color-danger); }
.dreaming-confirm { margin-inline-start: var(--space-2); color: var(--color-link); font-weight: var(--weight-medium); text-decoration: none; user-select: none; }
.dreaming-confirm:hover { text-decoration: underline; }
</style>
