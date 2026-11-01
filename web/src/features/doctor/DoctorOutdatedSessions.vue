<script setup lang="ts">
import { computed } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { useSessionLaunchOffers } from '@/features/knowledge/session-launch-offers'
import { t } from '@/i18n'
import { outdatedSessionKey, outdatedSessionLabel, type OutdatedSession } from './model'

// The sessions of a sessions_outdated item that the session launcher can open,
// each with a plain link the person clicks; asked when the panel shows them.
// A session without a link is not listed.
const props = defineProps<{ sessions: OutdatedSession[] }>()

const { offers, pending } = useSessionLaunchOffers(computed(() => props.sessions.map(outdatedSessionKey)))
const links = computed(() => props.sessions.flatMap((session) => {
  const href = offers.value.get(outdatedSessionKey(session))?.href
  return href ? [{ key: outdatedSessionKey(session), label: outdatedSessionLabel(session), href }] : []
}))
</script>

<template>
  <GrowthLoading v-if="pending" variant="inline" :label="t('doctor.sessionLinks.loading')" data-doctor-sessions-loading />
  <ul v-else-if="links.length" class="doctor-sessions" data-doctor-sessions>
    <li v-for="link in links" :key="link.key">
      <span>{{ link.label }}</span>
      <Button as-child variant="link" size="sm" class="doctor-session-open">
        <a :href="link.href" rel="noreferrer" data-doctor-session-open>{{ t('doctor.sessionLinks.open') }}</a>
      </Button>
    </li>
  </ul>
</template>

<style scoped>
.doctor-sessions { display: grid; gap: 2px; margin: 4px 0 0; padding: 0; list-style: none; color: var(--color-muted); }
.doctor-sessions li { display: flex; align-items: baseline; gap: 8px; }
.doctor-session-open { height: auto; padding: 0; }
</style>
