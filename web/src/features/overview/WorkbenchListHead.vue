<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'

// A workbench list card's head: its name and, when more rows wait than the
// card shows, 「更多 N」 to the list's own page, where the card grows into it.
defineProps<{ id: string; list: 'running' | 'done' | 'notices'; title: string; more: number }>()
</script>

<template>
  <header class="workbench-card-head">
    <h2 :id="id">{{ title }}</h2>
    <Button v-if="more > 0" as-child variant="ghost" size="sm">
      <RouterLink :to="`/workbench/${list}`" :data-workbench-more="list">{{ t('overview.more', { count: more }) }}</RouterLink>
    </Button>
  </header>
</template>
