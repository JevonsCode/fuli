<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'

// Under a changed restart setting (ports, LAN access, runtime): it waits for
// the person's own 应用并重启 instead of saving itself (settings-restart.ts).
defineProps<{ applying: boolean; error: string }>()
const emit = defineEmits<{ apply: [] }>()
</script>

<template>
  <UiNotice :tone="error ? 'error' : 'warning'" class="settings-restart-notice" data-settings-restart-notice>
    {{ error || t('settings.restart.pending') }}
    <template #actions>
      <Button type="button" size="sm" :loading="applying" :loading-label="t('settings.applying')" data-settings-restart-apply @click="emit('apply')">
        {{ t('settings.restart.apply') }}
      </Button>
    </template>
  </UiNotice>
</template>
