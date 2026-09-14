<script setup lang="ts">
import ConsoleLayout from '@/layouts/ConsoleLayout.vue'
import { RouterView, useRoute } from 'vue-router'
const route = useRoute()
</script>

<template>
  <RouterView v-if="route.meta.publicReport" />
  <ConsoleLayout v-else />
</template>
