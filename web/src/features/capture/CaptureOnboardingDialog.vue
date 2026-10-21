<script setup lang="ts">
import { computed, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
const CHOICES: readonly CaptureScopeChoice[] = ['all', 'selected', 'off']

const store = useConsoleStore()
const dismissed = ref(false)
const open = computed(() => store.state?.captureOnboarding?.ask === true && !dismissed.value)
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
  if (!value && !saving.value) dismissed.value = true
}

function chooseScope(value: unknown) {
  choice.value = value as CaptureScopeChoice
  failure.value = ''
}

async function save() {
  const scope = choice.value
  if (!scope || saving.value) return
  pending.value = 'saving'
  failure.value = ''
  try {
    const outcome = await store.answerCaptureScope(scope === 'selected'
      ? { choice: scope, selectedProjectIds: projects.value.filter(project => ticked.value[project.id]).map(project => project.id) }
      : { choice: scope })
    store.notify(outcome.status === 'answered' ? t(`capture.onboarding.saved.${outcome.choice}`) : t('capture.onboarding.gone'))
  } catch (error) {
    await checkSaved(apiErrorReason(error))
  } finally {
    pending.value = null
  }
}

// A failed request may still have saved (a lost response, or settings saved
// before a later step failed), so nothing is claimed until the server says
// what it holds. A question still open means the settings are still the
// ones it opened with: recording is off.
async function checkSaved(reason: string) {
  pending.value = 'checking'
  failure.value = t('capture.onboarding.unconfirmed')
  try {
    const read = await store.readCaptureOnboarding()
    if (read.ask) {
      failure.value = t('capture.onboarding.notSaved', { reason })
      return
    }
    failure.value = ''
    const saved = savedCaptureScope(read.capturePolicy)
    store.notify(saved ? t(`capture.onboarding.saved.${saved}`) : t('capture.onboarding.gone'))
  } catch (error) {
    failure.value = t('capture.onboarding.unknown', { reason: apiErrorReason(error) })
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="openChange">
    <DialogContent data-capture-onboarding @pointer-down-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t('capture.onboarding.title') }}</DialogTitle>
        <DialogDescription>{{ t('capture.onboarding.description') }}</DialogDescription>
      </DialogHeader>

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

      <DialogFooter>
        <Button variant="ghost" :disabled="saving" data-capture-scope-later @click="openChange(false)">
          {{ t('capture.onboarding.later') }}
        </Button>
        <Button :disabled="!choice" :loading="saving" :loading-label="t(pending === 'checking' ? 'capture.onboarding.checking' : 'capture.onboarding.saving')" data-capture-scope-save
          @click="save">
          {{ t('capture.onboarding.save') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* A chosen scope lifts as a card: surface, a fine border and a light shadow. */
.onboarding-option { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--color-border);
  border-radius: 10px; cursor: pointer; transition: background-color .15s, box-shadow .15s, border-color .15s; }
.onboarding-option:hover { background: var(--color-surface-hover); }
.onboarding-option[data-selected] { background: var(--color-surface); border-color: var(--color-border-strong); box-shadow: var(--shadow-sm); }
.onboarding-option > span { display: grid; gap: 2px; min-width: 0; }
.onboarding-option strong { font-size: 14px; font-weight: 550; }
.onboarding-option small { color: var(--color-muted); font-size: 12px; overflow-wrap: anywhere; }
.onboarding-projects { display: grid; gap: 8px; }
.onboarding-projects-label { font-size: 13px; font-weight: 550; }
.onboarding-projects ul { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 16px;
  max-height: 240px; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.onboarding-projects label { display: flex; align-items: center; gap: 8px; min-height: 32px; min-width: 0; cursor: pointer; }
.onboarding-project-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.onboarding-note { margin: 0; color: var(--color-muted); font-size: 13px; }
.onboarding-error { margin: 0; color: var(--color-danger); font-size: 13px; }
</style>
