<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
</script>

<template>
  <section class="view">
    <div class="empty-state" role="status">
      <p>{{ t('common.errors.pageNotFoundCopy') }}</p>
      <Button as-child variant="outline"><RouterLink to="/">{{ t('common.actions.backHome') }}</RouterLink></Button>
    </div>
  </section>
</template>
