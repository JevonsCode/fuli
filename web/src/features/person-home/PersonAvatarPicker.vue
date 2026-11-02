<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { generatedAvatarUrl } from '@/features/agent-profile/agent-avatar'
import type { LookChoice } from '@/features/agent-profile/agent-looks'
import { AVATAR_TYPES, AvatarImageError, scaleAvatarImage } from '@/features/agent-profile/avatar-image'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import MeAvatar from './MeAvatar.vue'
import { personProfile, savePersonProfile } from './person-profile'

// The person's own picture (「我」): a few drawings in the FLA portraits'
// style, a picture of their own (cropped to a square and scaled down here),
// or the neutral face again. A choice is saved at once; another choice
// undoes it, so nothing asks twice.
const props = defineProps<{ spaceId: string; disabled?: boolean }>()
const CHOICES = 6

const open = ref(false)
const seeds = ref<string[]>([])
const saving = ref(false)
const reading = ref(false)
const error = ref('')
const file = ref<HTMLInputElement | null>(null)
const changed = computed(() => Boolean(personProfile.value?.look?.kind) && personProfile.value?.look?.kind !== 'default')
const busy = computed(() => saving.value || reading.value)

const shuffle = () => { seeds.value = Array.from({ length: CHOICES }, () => crypto.randomUUID()) }
watch(open, (value) => {
  error.value = ''
  if (value) shuffle()
})

async function save(look: LookChoice) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    await savePersonProfile(props.spaceId, { look })
    open.value = false
  } catch (cause) {
    error.value = t('preferences.home.avatar.failed', { reason: apiErrorReason(cause) })
  } finally {
    saving.value = false
  }
}

const IMAGE_ERRORS = { type: 'agentProfiles.look.type', unreadable: 'agentProfiles.look.unreadable', too_large: 'agentProfiles.look.tooLarge' } as const

async function picked(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen) return
  reading.value = true
  error.value = ''
  let data: string
  try {
    data = await scaleAvatarImage(chosen)
  } catch (cause) {
    error.value = t(cause instanceof AvatarImageError ? IMAGE_ERRORS[cause.reason] : 'agentProfiles.look.unreadable')
    return
  } finally {
    reading.value = false
  }
  await save({ kind: 'image', data })
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="ghost" class="person-avatar-trigger" :disabled="disabled" :aria-label="t('preferences.home.avatar.change')" data-person-avatar-trigger>
        <MeAvatar :size="88" />
        <span class="person-avatar-badge" aria-hidden="true"><UiIcon name="edit" :size="13" /></span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :aria-label="t('preferences.home.avatar.title')" data-person-avatar-panel>
      <div class="person-avatar-panel">
        <p class="person-avatar-label">{{ t('preferences.home.avatar.choices') }}</p>
        <div class="person-avatar-choices">
          <Button v-for="(seed, index) in seeds" :key="seed" variant="ghost" class="person-avatar-choice" :disabled="busy"
            :aria-label="`${t('preferences.home.avatar.choices')} ${index + 1}`" data-person-avatar-choice @click="save({ kind: 'generated', seed })">
            <img :src="generatedAvatarUrl(seed)" alt="" />
          </Button>
        </div>
        <GrowthLoading v-if="saving" variant="inline" :label="t('preferences.home.avatar.saving')" />
        <GrowthLoading v-else-if="reading" variant="inline" :label="t('preferences.home.avatar.reading')" />
        <p v-if="error" class="person-avatar-error" role="alert">{{ error }}</p>
        <div class="person-avatar-actions">
          <Button variant="outline" size="sm" :disabled="busy" data-person-avatar-shuffle @click="shuffle">{{ t('preferences.home.avatar.shuffle') }}</Button>
          <Button variant="outline" size="sm" :disabled="busy" data-person-avatar-upload @click="file?.click()">{{ t('preferences.home.avatar.upload') }}</Button>
          <Button v-if="changed" variant="ghost" size="sm" :disabled="busy" data-person-avatar-reset @click="save({ kind: 'default' })">
            {{ t('preferences.home.avatar.reset') }}
          </Button>
        </div>
        <input ref="file" class="sr-only" type="file" :accept="AVATAR_TYPES.join(',')" tabindex="-1" aria-hidden="true" data-person-avatar-file @change="picked" />
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
/* Both are the shared Button (ghost) drawn as the picture itself: no box, no
   control height, no hover tint; the picture and its badge are the affordance. */
.person-avatar-trigger {
  position: relative; display: block; flex: none; width: auto; height: auto; min-height: 0; padding: 0; border: 0;
  border-radius: 50%; background: none; cursor: pointer; -webkit-user-select: none; user-select: none;
}
.person-avatar-trigger:hover:not(:disabled) { background: none; }
.person-avatar-trigger:disabled { cursor: default; opacity: 1; }
.person-avatar-trigger:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
.person-avatar-badge {
  position: absolute; right: 2px; bottom: 2px; display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%;
  color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border);
  opacity: 0; transform: scale(.8); transition: opacity var(--motion-fast) var(--motion-ease), transform var(--motion-fast) var(--motion-ease);
}
.person-avatar-trigger:not(:disabled):hover .person-avatar-badge, .person-avatar-trigger:focus-visible .person-avatar-badge,
.person-avatar-trigger[data-state="open"] .person-avatar-badge { opacity: 1; transform: none; }
.person-avatar-panel { display: grid; gap: 10px; width: 232px; }
.person-avatar-label { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.person-avatar-choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.person-avatar-choice {
  display: block; width: 100%; height: auto; min-height: 0; aspect-ratio: 1; overflow: hidden; padding: 0; border: 0;
  border-radius: 50%; background: var(--color-surface-subtle);
  cursor: pointer; transition: transform var(--motion-fast) var(--motion-ease), box-shadow var(--motion-fast) var(--motion-ease);
  -webkit-user-select: none; user-select: none;
}
.person-avatar-choice:hover:not(:disabled) { background: var(--color-surface-subtle); box-shadow: 0 0 0 2px var(--color-border-strong); transform: translateY(-1px); }
.person-avatar-choice:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.person-avatar-choice img { width: 100%; height: 100%; object-fit: cover; }
.person-avatar-error { margin: 0; color: var(--color-danger); font-size: var(--text-meta); }
.person-avatar-actions { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
