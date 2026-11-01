<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import FirstRunClients from '@/features/first-run/FirstRunClients.vue'
import FirstRunLaunchAtLogin from '@/features/first-run/FirstRunLaunchAtLogin.vue'
import { isFormalProject, pickerOrder, projectDisplayName } from '@/features/projects/project-origin'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { CaptureScopeChoice } from '@/types'
import { savedCaptureScope } from './capture-onboarding'

// A new installation's one question (rec#5 C10): "FULI 要在哪些项目里记录？"
// It opens over any console page while the server says the question is open,
// and nothing is recorded until the person answers. Closing it without an
// answer keeps recording off and the console asks again the next time it
// opens. Nothing is preselected: the person picks the scope themselves.
//
// For a new installation the same dialog is the first-run guide (Jevons
// 11-02): connect the AI clients found on this computer and start at login
// come first, the question last. 「跳过」 closes the guide for good and leaves
// the question for the next visit; 设置 › 客户端 opens the guide again.
const CHOICES: readonly CaptureScopeChoice[] = ['all', 'selected', 'off']

const store = useConsoleStore()
const dismissed = ref(false)
const asking = computed(() => store.state?.captureOnboarding?.ask === true && !dismissed.value)
const guide = computed(() => store.firstRunGuideShown)
const open = computed(() => asking.value || guide.value)
const connecting = ref(false)
// Opened again from 设置 › 客户端: an open question shows again too.
watch(guide, shown => { if (shown) dismissed.value = false })
const choice = ref<CaptureScopeChoice | null>(null)
const ticked = ref<Record<string, boolean>>({})
// The request in flight: the answer, then, when its result is unknown, the read that finds out.
const pending = ref<'saving' | 'checking' | null>(null)
const saving = computed(() => pending.value !== null)
const failure = ref('')

const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => pickerOrder((store.state?.personalProjects ?? [])
  .filter(project => project.personal_space_id === spaceId.value && isFormalProject(project)))
  .map(project => ({ id: project.project_id, name: projectDisplayName(project) })))

function openChange(value: boolean) {
  if (value || saving.value || connecting.value) return
  dismissed.value = true
  if (guide.value) void store.closeFirstRunGuide('skipped')
}

async function finish() {
  if (asking.value && !await save()) return
  if (guide.value) void store.closeFirstRunGuide('finished')
}

function chooseScope(value: unknown) {
  choice.value = value as CaptureScopeChoice
  failure.value = ''
}

// True once the question is closed: answered here or found answered.
async function save(): Promise<boolean> {
  const scope = choice.value
  if (!scope || saving.value) return false
  pending.value = 'saving'
  failure.value = ''
  try {
    const outcome = await store.answerCaptureScope(scope === 'selected'
      ? { choice: scope, selectedProjectIds: projects.value.filter(project => ticked.value[project.id]).map(project => project.id) }
      : { choice: scope })
    store.notify(outcome.status === 'answered' ? t(`capture.onboarding.saved.${outcome.choice}`) : t('capture.onboarding.gone'))
    return true
  } catch (error) {
    return await checkSaved(apiErrorReason(error))
  } finally {
    pending.value = null
  }
}

// A failed request may still have saved (a lost response, or settings saved
// before a later step failed), so nothing is claimed until the server says
// what it holds. A question still open means the settings are still the
// ones it opened with: recording is off.
async function checkSaved(reason: string): Promise<boolean> {
  pending.value = 'checking'
  failure.value = t('capture.onboarding.unconfirmed')
  try {
    const read = await store.readCaptureOnboarding()
    if (read.ask) {
      failure.value = t('capture.onboarding.notSaved', { reason })
      return false
    }
    failure.value = ''
    const saved = savedCaptureScope(read.capturePolicy)
    store.notify(saved ? t(`capture.onboarding.saved.${saved}`) : t('capture.onboarding.gone'))
    return true
  } catch (error) {
    failure.value = t('capture.onboarding.unknown', { reason: apiErrorReason(error) })
    return false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="openChange">
    <DialogContent data-capture-onboarding :data-first-run-guide="guide || undefined" :size="guide ? 'lg' : 'md'"
      class="first-run-glass" @pointer-down-outside.prevent>
      <DialogHeader>
        <DialogTitle class="first-run-title">{{ t(guide ? 'firstRun.title' : 'capture.onboarding.title') }}</DialogTitle>
        <DialogDescription>{{ t(guide ? 'firstRun.description' : 'capture.onboarding.description') }}</DialogDescription>
      </DialogHeader>

      <template v-if="guide">
        <FirstRunClients v-model:busy="connecting" />
        <FirstRunLaunchAtLogin />
      </template>

      <section v-if="asking" class="first-run-step" aria-labelledby="first-run-capture-title" data-first-run-capture>
      <h3 v-if="guide" id="first-run-capture-title" class="ui-group-label">{{ t('capture.onboarding.title') }}</h3>
      <RadioGroup :model-value="choice ?? undefined" :aria-label="t('capture.onboarding.choicesLabel')" class="grid gap-2"
        :disabled="saving" @update:model-value="chooseScope">
        <label v-for="option in CHOICES" :key="option" class="onboarding-option" :data-capture-scope="option"
          :data-selected="choice === option || undefined">
          <RadioGroupItem :value="option" />
          <span><strong>{{ t(`capture.onboarding.choices.${option}`) }}</strong><small>{{ t(`capture.onboarding.hints.${option}`) }}</small></span>
        </label>
      </RadioGroup>

      <section v-if="choice === 'selected'" class="onboarding-projects" data-capture-scope-projects>
        <span class="onboarding-projects-label">{{ t('capture.onboarding.projectsLabel') }}</span>
        <p v-if="!projects.length" class="onboarding-note">{{ t('capture.onboarding.noProjects') }}</p>
        <ul v-else>
          <li v-for="project in projects" :key="project.id" :data-capture-scope-project="project.id">
            <label>
              <Checkbox :model-value="ticked[project.id] === true" :disabled="saving"
                @update:model-value="value => ticked = { ...ticked, [project.id]: value === true }" />
              <span class="onboarding-project-name">{{ project.name }}</span>
            </label>
          </li>
        </ul>
      </section>

      <p v-if="failure" class="onboarding-error" role="alert" data-capture-scope-error>{{ failure }}</p>
      </section>

      <DialogFooter>
        <Button variant="ghost" :disabled="saving || connecting" :data-capture-scope-later="guide ? undefined : ''"
          :data-first-run-skip="guide || undefined" @click="openChange(false)">
          {{ t(guide ? 'firstRun.skip' : 'capture.onboarding.later') }}
        </Button>
        <Button :disabled="(asking && !choice) || connecting" :loading="saving"
          :loading-label="t(pending === 'checking' ? 'capture.onboarding.checking' : 'capture.onboarding.saving')" data-capture-scope-save
          @click="finish">
          {{ t(asking ? 'capture.onboarding.save' : 'firstRun.done') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* The dialog floats over the page, so it is glass (docs/console-design.md). */
:global(.first-run-glass) { border-color: var(--edge-glass); background: var(--surface-glass-strong); box-shadow: var(--shadow-glass);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock); }
:global(.first-run-glass .first-run-title) { font-size: 18px; font-weight: var(--weight-strong); }
:global(.first-run-glass .first-run-step) { display: grid; gap: 8px; min-width: 0; }
:global(.first-run-glass .first-run-step + .first-run-step) { padding-top: 16px; border-top: 1px solid var(--color-border); }
:global(.first-run-glass .first-run-step__head) { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--control-height-sm); }
:global(.first-run-glass .first-run-note) { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
/* A chosen scope lifts as a card: surface, a fine border and a light shadow. */
.onboarding-option { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--color-border);
  border-radius: 10px; cursor: pointer; user-select: none; transition: background-color .15s, box-shadow .15s, border-color .15s; }
.onboarding-option:hover { background: var(--color-surface-hover); }
.onboarding-option[data-selected] { background: var(--color-surface); border-color: var(--color-border-strong); box-shadow: var(--shadow-sm); }
.onboarding-option > span { display: grid; gap: 2px; min-width: 0; }
.onboarding-option strong { font-size: 14px; font-weight: 550; }
.onboarding-option small { color: var(--color-muted); font-size: 12px; overflow-wrap: anywhere; }
.onboarding-projects { display: grid; gap: 8px; }
.onboarding-projects-label { font-size: 13px; font-weight: 550; }
.onboarding-projects ul { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 16px;
  max-height: 240px; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.onboarding-projects label { display: flex; align-items: center; gap: 8px; min-height: 32px; min-width: 0; cursor: pointer; user-select: none; }
.onboarding-project-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.onboarding-note { margin: 0; color: var(--color-muted); font-size: 13px; }
.onboarding-error { margin: 0; color: var(--color-danger); font-size: 13px; }
</style>
