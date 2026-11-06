<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { queuedLessons, readRetrospective, shownRetrospective, type TaskRetrospective } from './retrospective'

// A finished task's retrospective, read once the details open. Nothing shows
// until Astro has written one: an empty task view says nothing about it.
const props = defineProps<{ taskId: string, active: boolean }>()
const value = ref<TaskRetrospective | null>(null)
const loading = ref(false)
let read = false
watch(() => props.active, async (active) => {
  if (!active || read) return
  read = true
  loading.value = true
  try { value.value = shownRetrospective(await readRetrospective(props.taskId)) }
  catch { value.value = null }
  finally { loading.value = false }
}, { immediate: true })
const queued = computed(() => (value.value ? queuedLessons(value.value) : 0))
</script>

<template>
  <GrowthLoading v-if="loading" variant="inline" :label="t('projectAgents.retrospective.loading')" />
  <section v-else-if="value" class="task-retrospective" data-task-retrospective :aria-label="t('projectAgents.retrospective.title')">
    <div class="project-agent-section-heading">
      <h5>{{ t('projectAgents.retrospective.title') }}</h5>
      <RouterLink v-if="queued" to="/inbox" data-retrospective-confirm>{{ t('projectAgents.retrospective.confirm', { count: queued }) }}</RouterLink>
    </div>
    <p v-if="value.wordsRemoved" class="project-agent-muted">{{ t('projectAgents.retrospective.removed') }}</p>
    <template v-else>
      <p class="ui-prose">{{ value.summary }}</p>
      <template v-if="value.problems.length">
        <h6>{{ t('projectAgents.retrospective.problems') }}</h6>
        <ul><li v-for="problem in value.problems" :key="problem">{{ problem }}</li></ul>
      </template>
      <template v-if="value.lessons.length">
        <h6>{{ t('projectAgents.retrospective.lessons') }}</h6>
        <ul><li v-for="lesson in value.lessons" :key="lesson.title">{{ lesson.title }}</li></ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
.task-retrospective { display: grid; gap: var(--space-2); }
.task-retrospective h6 { margin: 0; font-size: var(--text-meta); font-weight: var(--weight-medium); color: var(--muted-foreground); }
.task-retrospective ul { margin: 0; padding-inline-start: 1.2em; display: grid; gap: var(--space-1); }
.task-retrospective p { margin: 0; }
</style>
