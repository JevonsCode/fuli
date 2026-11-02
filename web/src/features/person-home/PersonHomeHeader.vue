<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import SettingsSaveCapsule, { type SaveCapsuleState } from '@/features/settings/SettingsSaveCapsule.vue'
import { useSettingsAutoSave } from '@/features/settings/settings-autosave'
import { t } from '@/i18n'
import { UiNotice } from '@/ui'
import AgentNamingStyleField from './AgentNamingStyleField.vue'
import PersonAvatarPicker from './PersonAvatarPicker.vue'
import { PERSON_NAME_MAX_CHARS, loadPersonProfile, personProfile, savePersonProfile } from './person-profile'
import { useAgentNamingStyle } from './use-agent-naming-style'

// The top of the person's own home (「我」): their picture and what FULI calls
// them, then how Bole names new FLAs. Both texts save themselves after a pause
// in typing, like Settings; the capsule says when, and nothing on the page moves.
const props = defineProps<{ spaceId: string }>()
const BOLE = 'employee.bole'

const name = ref('')
// The read answer becomes the field once; after that the field is the person's.
let nameAdopted = false
const profileReady = computed(() => typeof personProfile.value?.name === 'string')
const nameSave = useSettingsAutoSave({
  read: () => name.value.trim(),
  save: async (value) => { await savePersonProfile(props.spaceId, { name: value }) },
  ready: () => profileReady.value,
})
watch(personProfile, (profile) => {
  if (nameAdopted || typeof profile?.name !== 'string') return
  nameAdopted = true
  name.value = profile.name
  nameSave.remember(profile.name)
}, { immediate: true })

const naming = useAgentNamingStyle()
const detailsOpen = ref(false)

watch(() => props.spaceId, (spaceId) => {
  void loadPersonProfile(spaceId)
  void naming.load()
}, { immediate: true })

// One capsule for both texts: the save under way, else a failure, else the last saved.
const states = computed(() => [nameSave.state.value, naming.autoSave.state.value])
const capsuleState = computed<SaveCapsuleState>(() =>
  (['saving', 'error', 'saved'] as const).find(state => states.value.includes(state)) ?? 'idle')
const capsuleFailure = computed(() => nameSave.failure.value || naming.autoSave.failure.value)
function retry() {
  if (nameSave.state.value === 'error') nameSave.retry()
  if (naming.autoSave.state.value === 'error') naming.autoSave.retry()
}
</script>

<template>
  <section class="person-home" :aria-label="t('preferences.home.aria')" data-person-home>
    <div class="person-home-identity">
      <PersonAvatarPicker :space-id="spaceId" :disabled="!profileReady" />
      <div class="person-home-name">
        <label for="person-home-name" class="person-home-title">{{ t('preferences.home.name.title') }}</label>
        <Input id="person-home-name" v-model="name" class="person-home-name-input" :maxlength="PERSON_NAME_MAX_CHARS"
          :placeholder="t('preferences.home.name.placeholder')" autocomplete="nickname" :disabled="!profileReady"
          aria-describedby="person-home-name-hint" data-person-name @input="nameSave.changed('text')" @keydown.enter="nameSave.changed('choice')" />
        <small id="person-home-name-hint" class="person-home-hint">{{ t('preferences.home.name.hint') }}</small>
      </div>
    </div>

    <div class="person-home-naming" data-person-naming>
      <div class="person-home-naming-head">
        <img class="person-home-bole" :src="agentAvatarUrl(BOLE)" alt="" :data-agent-portrait="BOLE" data-person-naming-bole />
        <div class="person-home-naming-copy">
          <strong id="person-home-naming-title">{{ t('preferences.home.naming.title') }}</strong>
          <small id="person-home-naming-note">{{ t('preferences.home.naming.bole') }}</small>
        </div>
        <Button variant="ghost" size="sm" class="person-home-details" data-person-naming-details @click="detailsOpen = true">{{ t('ui.details') }}</Button>
      </div>
      <AgentNamingStyleField v-if="naming.loaded.value" v-model="naming.style.value" labelledby="person-home-naming-title"
        describedby="person-home-naming-note" @update:model-value="naming.changed()" />
      <UiNotice v-else-if="naming.failed.value" tone="warning" data-person-naming-failed>
        {{ t('preferences.home.naming.failed') }}
        <template #actions><Button variant="link" size="xs" @click="naming.load()">{{ t('preferences.detail.reload') }}</Button></template>
      </UiNotice>
    </div>

    <Dialog :open="detailsOpen" @update:open="detailsOpen = $event">
      <DialogContent size="md" data-person-naming-dialog>
        <DialogHeader>
          <DialogTitle>{{ t('preferences.home.naming.title') }}</DialogTitle>
          <DialogDescription>{{ t('glossary.setting.agentNamingStyle') }}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
    <SettingsSaveCapsule :state="capsuleState" :failure="capsuleFailure" @retry="retry" />
  </section>
</template>

<style scoped>
/* One card for who the person is: identity first, then how Bole names FLAs.
   A plain surface, not glass (glass is for floating UI). */
.person-home {
  display: grid; gap: 18px; padding: 22px 24px; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: var(--card);
}
.person-home-identity { display: flex; align-items: center; gap: 22px; min-width: 0; }
.person-home-name { display: grid; flex: 1; gap: 8px; min-width: 0; max-width: 440px; }
.person-home-title { color: var(--color-ink); font-size: var(--text-section); font-weight: var(--weight-strong); }
.person-home-hint { color: var(--color-muted); font-size: var(--text-meta); }
.person-home-naming { display: grid; gap: 10px; padding-top: 16px; border-top: 1px solid var(--color-border); }
.person-home-naming-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.person-home-bole {
  flex: none; width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: var(--color-surface-subtle);
  box-shadow: 0 0 0 1px var(--color-border);
}
.person-home-naming-copy { display: grid; flex: 1; gap: 2px; min-width: 0; }
.person-home-naming-copy strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.person-home-naming-copy small { color: var(--color-muted); font-size: var(--text-meta); }
.person-home-details { flex: none; -webkit-user-select: none; user-select: none; }
@media (max-width: 560px) {
  .person-home { padding: 18px 16px; }
  /* A phone stacks the picture over the question, so the field keeps the full width. */
  .person-home-identity { flex-direction: column; align-items: flex-start; gap: 14px; }
  .person-home-name { width: 100%; }
}
</style>
