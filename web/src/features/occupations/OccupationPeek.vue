<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n'
import { occupationDescription, occupationName } from './occupation-catalog'
import type { OccupationPeekState } from './occupation-peek'

// One occupation in the quick look: its name, the work it covers, how many
// Agents hold it, and its quick changes. An occupation has no larger page, so
// everything about it is here. It renders inside the page's Dialog.
defineProps<{
  state: OccupationPeekState
  /** The quick change in flight on this occupation, if any. */
  busy: '' | 'archive' | 'restore' | 'remove'
  actionError: string
}>()
const emit = defineEmits<{ edit: []; archive: []; restore: []; remove: []; retry: []; close: [] }>()
</script>

<template>
  <template v-if="state.kind !== 'ready'">
    <DialogHeader>
      <DialogTitle>{{ t('occupations.details') }}</DialogTitle>
      <DialogDescription :class="{ 'sr-only': state.kind === 'loading' }">
        {{ state.kind === 'missing' ? t('occupations.notFound') : state.kind === 'error' ? t('occupations.loadFailed') : t('occupations.loading') }}
      </DialogDescription>
    </DialogHeader>
    <GrowthLoading v-if="state.kind === 'loading'" variant="compact" :label="t('occupations.loading')" />
    <!-- A failed read keeps the link and offers to read again; it never claims the occupation is gone. -->
    <p v-if="state.kind === 'error'" class="m-0 text-sm text-destructive [overflow-wrap:anywhere]" role="alert" data-occupation-peek-error>{{ state.message }}</p>
    <DialogFooter v-if="state.kind !== 'loading'" class="border-t pt-4">
      <Button variant="outline" data-peek-close @click="emit('close')">{{ t('common.actions.close') }}</Button>
      <Button v-if="state.kind === 'error'" data-peek-retry @click="emit('retry')">{{ t('occupations.retry') }}</Button>
    </DialogFooter>
  </template>
  <template v-else>
    <DialogHeader>
      <DialogTitle class="pr-8 text-xl leading-tight [overflow-wrap:anywhere]">{{ occupationName(state.entry) }}</DialogTitle>
      <DialogDescription class="flex flex-wrap items-center gap-2">
        <Badge v-if="state.entry.builtin" variant="secondary">{{ t('occupations.builtin') }}</Badge>
        <Badge v-if="state.entry.status === 'archived'" variant="warning">{{ t('occupations.stats.archived') }}</Badge>
        <span>{{ t('occupations.agentCount', { count: state.entry.agent_count }) }}</span>
      </DialogDescription>
    </DialogHeader>
    <section class="grid gap-1 border-t pt-4 text-sm" :aria-label="t('occupations.dialog.duties')">
      <h3 class="m-0 text-xs font-semibold text-muted-foreground">{{ t('occupations.dialog.duties') }}</h3>
      <p class="m-0 leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]" data-occupation-peek-duties>
        {{ occupationDescription(state.entry) || t('occupations.noDescription') }}
      </p>
    </section>
    <p v-if="state.entry.status === 'active'" class="m-0 text-sm text-muted-foreground" data-occupation-archive-hint>{{ t('occupations.archiveHint') }}</p>
    <p v-if="actionError" class="m-0 text-sm text-destructive" role="alert">{{ actionError }}</p>
    <DialogFooter class="border-t pt-4">
      <Button v-if="!state.entry.builtin" variant="destructive" :disabled="Boolean(busy) || state.entry.agent_count > 0"
        :title="state.entry.agent_count > 0 ? t('occupations.inUse') : undefined" :loading="busy === 'remove'" :loading-label="t('occupations.removing')"
        class="sm:mr-auto" data-peek-remove @click="emit('remove')">{{ t('occupations.remove') }}</Button>
      <Button v-if="state.entry.status === 'active'" variant="outline" :disabled="Boolean(busy)" :loading="busy === 'archive'"
        :loading-label="t('occupations.archiving')" data-term="occupation.archived" data-peek-archive @click="emit('archive')">{{ t('occupations.archive') }}</Button>
      <Button v-else variant="outline" :disabled="Boolean(busy)" :loading="busy === 'restore'" :loading-label="t('occupations.restoring')"
        data-term="occupation.archived" data-peek-restore @click="emit('restore')">{{ t('occupations.restore') }}</Button>
      <Button :disabled="Boolean(busy)" data-peek-edit @click="emit('edit')">{{ t('occupations.edit') }}</Button>
    </DialogFooter>
  </template>
</template>
