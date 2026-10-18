<script setup lang="ts">
import AppShell from '@/layouts/AppShell.vue'
import { RouterView, useRoute } from 'vue-router'
const route = useRoute()
</script>

<template>
  <RouterView v-if="route.meta.publicReport" />
  <AppShell v-else />
</template>
