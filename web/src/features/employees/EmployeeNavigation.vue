<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import { employeeTemplates, refreshEmployeeCatalog } from './catalog'
const props = defineProps<{ personalSpaceId: string }>()
watch(() => props.personalSpaceId, (id) => { void refreshEmployeeCatalog(id === 'current' ? '' : id) }, { immediate: true })
const employees = computed(() => employeeTemplates.value.filter((entry) => entry.agentId && entry.agentStatus === 'active' && entry.runtime))
</script>

<template>
  <template v-if="employees.length">
    <p class="nav-section-label">{{ t('employees.directory') }}</p>
    <RouterLink v-for="employee in employees" :key="employee.id" :to="`/employees/${encodeURIComponent(employee.id)}`" class="space-nav-button employee-nav" active-class="is-active">
      <span class="employee-nav-mark" aria-hidden="true">{{ employee.name.slice(0, 1) }}</span>
      <span class="nav-copy"><strong>{{ employee.name }}</strong><small>{{ employee.role }}</small></span>
    </RouterLink>
  </template>
</template>

<style scoped>
.employee-nav-mark { display: grid; flex: 0 0 26px; height: 26px; place-items: center; border-radius: 7px; background: #e3ece6; color: #315c43; font-size: 15px; font-weight: 650; }
</style>
