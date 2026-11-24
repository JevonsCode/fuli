<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
import { t } from '@/i18n'
import { UiNotice } from '@/ui'
import { changeText, markNameChangesSeen, readNameChanges, unseenRenames, type NameChanges } from './name-changes'

// Renames on the FLAs page. Names the person settled for FLAs that shared
// one are announced once (知道了 is kept with the space, so every console
// agrees); after that a quiet 改名记录 keeps the whole list, a person's own
// renames included, each FLA a link to its page. A failed read shows nothing:
// each FLA's page still says its 原名. revision: reread after a settle.
const props = defineProps<{ personalSpaceId: string; revision?: number }>()
const changes = ref<NameChanges | null>(null)
const open = ref(false)
const unseen = computed(() => changes.value ? unseenRenames(changes.value) : [])
const listed = computed(() => unseen.value.length ? unseen.value : changes.value?.items ?? [])

watch(() => [props.personalSpaceId, props.revision] as const, async ([space]) => {
  if (!space) return
  try {
    changes.value = await readNameChanges(space)
  } catch {
    changes.value = null
  }
}, { immediate: true })

async function dismiss() {
  if (!changes.value) return
  open.value = false
  try {
    changes.value = await markNameChangesSeen(props.personalSpaceId, changes.value)
  } catch {
    // The notice comes back on the next visit; nothing is lost.
  }
}
</script>

<template>
  <UiNotice v-if="unseen.length" tone="info" data-flas-renamed>
    <p>{{ t('flas.names.renamed', { count: unseen.length }) }}</p>
    <template #actions>
      <Button size="sm" variant="ghost" :aria-expanded="open" data-flas-renamed-toggle @click="open = !open">
        {{ open ? t('flas.names.hide') : t('flas.names.show') }}
      </Button>
      <Button size="sm" variant="ghost" data-flas-renamed-dismiss @click="dismiss">{{ t('flas.names.dismiss') }}</Button>
    </template>
  </UiNotice>
  <Button v-else-if="changes?.items.length" size="sm" variant="ghost" class="renamed-history" :aria-expanded="open"
    data-flas-renamed-history @click="open = !open">
    {{ t('flas.names.history', { count: changes.items.length }) }}
  </Button>
  <ul v-if="open && listed.length" class="renamed-list" data-flas-renamed-list>
    <li v-for="item in listed" :key="`${item.agentId}:${item.change.until}`" data-flas-renamed-item>
      <RouterLink :to="agentProfilePath(personalSpaceId, item.agentId)">{{ item.displayName }}</RouterLink>
      <span>{{ changeText(item) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.renamed-history { justify-self: start; color: var(--color-ink-soft); }
.renamed-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: var(--text-control); }
.renamed-list li { display: flex; flex-wrap: wrap; gap: 4px 8px; }
.renamed-list a { color: var(--color-ink); font-weight: var(--weight-medium); }
.renamed-list span { color: var(--color-muted); }
</style>
