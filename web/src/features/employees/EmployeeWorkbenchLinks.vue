<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { employeeTemplates, refreshEmployeeCatalog } from './catalog'
import { employeeAvatarUrl } from './avatars'

// Shortcuts into the fixed roles' workbenches (Jefa's board, Bole's people panel).
const props = defineProps<{ personalSpaceId: string }>()
watch(() => props.personalSpaceId, (id) => { void refreshEmployeeCatalog(id === 'current' ? '' : id) }, { immediate: true })
const employees = computed(() => employeeTemplates.value.filter((entry) => entry.agentId && entry.agentStatus === 'active'
  && (entry.runtime || entry.workbench?.kind === 'native')))
</script>

<template>
  <Button v-for="employee in employees" :key="employee.id" as-child variant="outline" class="employee-workbench-link">
    <RouterLink :to="`/employees/${encodeURIComponent(employee.id)}`" :title="t('agentProfiles.workbench')">
      <img v-if="employeeAvatarUrl(employee.id)" :src="employeeAvatarUrl(employee.id)" alt="" aria-hidden="true" />
      {{ employee.name }} · {{ employee.role }}
    </RouterLink>
  </Button>
</template>

<style scoped>
.employee-workbench-link img { width: 18px; height: 18px; border-radius: 5px; object-fit: cover; }
</style>
