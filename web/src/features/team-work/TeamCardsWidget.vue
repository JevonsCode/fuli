<script setup lang="ts">
import { computed } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import TeamCard from './TeamCard.vue'
import { useTeamPeople } from './useTeamPeople'
import { useTeamWork } from './useTeamWork'

// Widget 'team-cards': every task FLAs do together, one 团队卡片 each. It
// shows nothing at all when there is no team work (or the server cannot say),
// so a slot that holds it never shows an empty frame.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const team = useTeamWork(spaceId)
const people = useTeamPeople(spaceId, team.sheets)
</script>

<template>
  <section v-if="team.sheets.value.length || team.state.value === 'loading'" class="team-cards" aria-labelledby="team-cards-heading" data-widget="team-cards">
    <h2 id="team-cards-heading" class="team-cards-label">{{ t('teamWork.cards.title') }} <span v-if="team.sheets.value.length" class="ui-num">{{ team.sheets.value.length }}</span></h2>
    <GrowthLoading v-if="team.state.value === 'loading' && !team.sheets.value.length" variant="compact" :label="t('teamWork.cards.loading')" />
    <TransitionGroup v-else name="ui-list" tag="div" class="team-cards-list">
      <TeamCard v-for="sheet in team.sheets.value" :key="sheet.taskId" :sheet="sheet" :space-id="spaceId" :name-of="people.nameOf" :project-name="people.projectName" />
    </TransitionGroup>
  </section>
</template>

<style scoped>
.team-cards { display: grid; gap: 8px; }
.team-cards-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.team-cards-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.team-cards-list { display: grid; gap: 8px; }
</style>
