<script setup lang="ts">
import { RouterLink } from 'vue-router'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { UiDialog } from '@/ui'
import ModelFailureNote from './ModelFailureNote.vue'
import { queuedCount, type DreamingProject } from './dreaming'
import { useAdvice } from './model-uses'
import type { Dreaming } from './useDreaming'

// 「查看详情」 of Dreaming (11-11): every authorized project in a dialog that
// scrolls, so the card stays one height however many there are. Projects with
// new sessions come first, each with 「整理」; the rest are quieter and their
// 「整理一次」 reads every session again. A project that just ran keeps its
// place and says what it found, with a link to the review queue; one that did
// not finish says why and its button is 「重试」, with 「测试连接」 for Astro's
// model above the lists.
defineProps<{ open: boolean; dreaming: Dreaming; model: string | null }>()
const emit = defineEmits<{ close: []; edit: []; checked: [] }>()

// A full re-read is offered once the project has something it could read again.
const canRun = (project: DreamingProject, group: 'fresh' | 'quiet') => group === 'fresh' || project.lastRun !== null
const runLabel = (project: DreamingProject, fromStart: boolean) =>
  t(fromStart ? 'modelSettings.dreaming.rereading' : 'modelSettings.dreaming.running', { name: project.name })
</script>

<template>
  <UiDialog :open="open" title="Dreaming" :description="t('modelSettings.dreaming.daily')" size="lg" data-dreaming-dialog @close="emit('close')">
    <div class="dreaming-dialog">
      <p class="dreaming-note" data-dreaming-advice><span class="dreaming-label">{{ t('modelSettings.uses.advicePrefix') }}</span>{{ useAdvice('dreaming') }}</p>
      <ModelFailureNote v-if="dreaming.failed.length" :text="dreaming.summary.text" role="assistant" :model="model ?? ''" @checked="emit('checked')" />
      <template v-for="[group, rows] in ([['fresh', dreaming.fresh], ['quiet', dreaming.quiet]] as const)" :key="group">
        <ul v-if="rows.length" class="dreaming-list" :class="`dreaming-list--${group}`" :data-dreaming-list="group">
          <li v-for="project in rows" :key="project.personalProjectId" class="dreaming-row" :data-dreaming-row="project.personalProjectId">
            <span class="dreaming-name" :title="project.name">{{ project.name }}</span>
            <span class="dreaming-meta" :class="{ 'is-failed': dreaming.failureOf(project) }" :title="dreaming.meta(project)" data-dreaming-meta>{{ dreaming.meta(project) }}</span>
            <RouterLink v-if="queuedCount(dreaming.results[project.personalProjectId]) > 0" to="/inbox" class="dreaming-confirm" data-dreaming-confirm>
              {{ t('modelSettings.dreaming.confirm') }}
            </RouterLink>
            <Button v-if="canRun(project, group)" size="sm" :variant="group === 'fresh' ? 'outline' : 'ghost'"
              :title="group === 'quiet' ? t('modelSettings.dreaming.runAgainHint') : undefined"
              :disabled="dreaming.running !== null && dreaming.running.id !== project.personalProjectId"
              :loading="dreaming.running?.id === project.personalProjectId" :loading-label="runLabel(project, group === 'quiet')"
              data-dreaming-run @click="dreaming.run(project)">
              {{ dreaming.failureOf(project) ? t('modelSettings.retryAction') : t(group === 'fresh' ? 'modelSettings.dreaming.run' : 'modelSettings.dreaming.runAgain') }}
            </Button>
          </li>
        </ul>
      </template>
      <p v-if="dreaming.unapproved.length" class="dreaming-note" :title="dreaming.unapproved.map(project => project.name).join('、')" data-dreaming-unapproved>
        {{ t('modelSettings.dreaming.notApproved', { count: dreaming.unapproved.length }) }}
      </p>
    </div>
    <template #footer>
      <Button v-if="dreaming.unapproved.length" size="sm" variant="outline" data-dreaming-open @click="emit('edit')">
        {{ t('modelSettings.uses.openAstro') }}
      </Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.dreaming-dialog { display: grid; gap: var(--space-3); min-width: 0; }
.dreaming-note { margin: 0; color: var(--color-muted); font-size: var(--text-control); }
.dreaming-label { margin-inline-end: 8px; font-size: var(--text-meta); }
.dreaming-list { display: grid; margin: 0; padding: 0; list-style: none; font-size: var(--text-control); }
.dreaming-list--quiet { color: var(--color-muted); }
/* Every row is one control high, so rows with and without a button line up. */
.dreaming-row { display: flex; align-items: center; gap: var(--space-3); min-width: 0; min-height: var(--control-height-md); }
.dreaming-row + .dreaming-row { border-top: 1px solid var(--color-border); }
.dreaming-name { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--color-ink); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.dreaming-list--quiet .dreaming-name { font-weight: var(--weight-regular); }
.dreaming-meta { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--color-muted); text-overflow: ellipsis; white-space: nowrap; }
.dreaming-meta.is-failed { color: var(--color-danger); }
.dreaming-confirm { flex: none; color: var(--color-link); font-weight: var(--weight-medium); text-decoration: none; user-select: none; }
.dreaming-confirm:hover { text-decoration: underline; }
.dreaming-row :deep(button) { flex: none; margin-inline-start: auto; user-select: none; }
</style>
