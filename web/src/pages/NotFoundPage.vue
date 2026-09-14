<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
</script>

<template>
  <section class="view">
    <div class="empty-state" role="status">
      <p>{{ t('common.errors.pageNotFoundCopy') }}</p>
      <RouterLink class="secondary-action" to="/">{{ t('common.actions.backHome') }}</RouterLink>
    </div>
  </section>
</template>
