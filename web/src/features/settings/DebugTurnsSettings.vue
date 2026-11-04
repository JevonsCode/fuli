<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { listDebugTurns } from '@/features/debug-turns/model'
import { t } from '@/i18n'

// 调试记录: the #debug turn records, shown only once one exists.
const shown = ref(false)

onMounted(async () => {
  try {
    shown.value = (await listDebugTurns()).length > 0
  } catch {
    // Without the list there is nothing to open; the card stays away.
  }
})
</script>

<template>
  <Card v-if="shown" as="section" class="settings-card" aria-labelledby="settings-debug-turns-title" data-debug-turns-card>
    <CardHeader>
      <CardTitle id="settings-debug-turns-title" as="h2">{{ t('debugTurns.title') }}</CardTitle>
      <CardDescription>{{ t('debugTurns.settingsEntry') }}</CardDescription>
      <CardAction>
        <Button as-child size="sm" variant="outline">
          <RouterLink to="/settings/debug-turns" data-open-debug-turns>{{ t('debugTurns.open') }}</RouterLink>
        </Button>
      </CardAction>
    </CardHeader>
  </Card>
</template>
