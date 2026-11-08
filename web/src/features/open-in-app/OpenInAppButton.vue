<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { t } from '@/i18n'
import { UiIconButton } from '@/ui'
import { fuliLinkFor, offersOpenInApp } from './open-in-app'

// The page this browser tab shows, opened in this computer's FULI desktop
// client instead (a fuli:// link). Only offered outside the client, while the
// client opens those links.
const route = useRoute()
const offered = ref(false)
const link = computed(() => offered.value ? fuliLinkFor(route.path, route.query) : null)

onMounted(async () => { offered.value = await offersOpenInApp() })
</script>

<template>
  <UiIconButton v-if="link" icon="openInApp" :href="link" :label="t('openInApp.label')" draggable="false" data-open-in-app />
</template>
