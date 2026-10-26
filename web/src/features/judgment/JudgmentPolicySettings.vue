<script setup lang="ts">
import { computed } from 'vue'

import { useConsoleStore } from '@/stores/console'

import JudgmentPolicyPanel from './JudgmentPolicyPanel.vue'

const store = useConsoleStore()
const personalSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
</script>

<template>
  <JudgmentPolicyPanel :personal-space-id="personalSpaceId" />
</template>
