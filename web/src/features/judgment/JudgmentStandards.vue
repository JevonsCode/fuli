<script setup lang="ts">
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import PageColumns from '@/components/PageColumns.vue'
import type { PersonalProject } from '@/types'

import JudgmentPolicyPanel from './JudgmentPolicyPanel.vue'
import JudgmentProjectOverrides from './JudgmentProjectOverrides.vue'
import { judgmentText } from './judgment-copy'
import { JUDGMENT_STANDARD_GROUPS } from './judgment-standards'

// What Tonborg judges by, then the choices that are the person's: the default
// for every project and the projects that judge differently.
const props = withDefaults(defineProps<{ personalSpaceId: string; projects?: PersonalProject[] }>(), { projects: () => [] })
</script>

<template>
  <PageColumns>
    <Card as="section" data-span="wide" aria-labelledby="judgment-standards-title" data-judgment-standards>
      <CardHeader>
        <CardTitle id="judgment-standards-title" as="h2">{{ judgmentText('standards.title') }}</CardTitle>
        <CardDescription>{{ judgmentText('standards.hint') }}</CardDescription>
      </CardHeader>
      <div class="judgment-standard-groups">
        <PageColumns>
          <section v-for="group in JUDGMENT_STANDARD_GROUPS" :key="group.id" class="judgment-standard-group" :data-standard-group="group.id">
            <h3>{{ judgmentText(`standards.${group.id}.title`) }}</h3>
            <ul><li v-for="line in group.lines" :key="line">{{ judgmentText(`standards.${group.id}.${line}`) }}</li></ul>
          </section>
        </PageColumns>
      </div>
    </Card>
    <JudgmentPolicyPanel :personal-space-id="props.personalSpaceId" />
    <JudgmentProjectOverrides :personal-space-id="props.personalSpaceId" :projects="props.projects" />
  </PageColumns>
</template>

<style scoped>
.judgment-standard-groups { padding: 0 var(--space-5, 20px); }
.judgment-standard-group { display: grid; gap: 6px; }
.judgment-standard-group h3 { margin: 0; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.judgment-standard-group ul { display: grid; gap: 5px; margin: 0; padding-left: 18px; color: var(--color-muted); font-size: 13px; line-height: 1.55; }
</style>
