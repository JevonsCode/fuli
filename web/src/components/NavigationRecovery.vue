<script setup lang="ts">
import { t } from '@/i18n'
import { navigationFailure } from '@/router/navigation-recovery'
</script>

<template>
  <div v-if="navigationFailure" class="navigation-recovery" role="alert">
    <div>
      <strong>{{ t('routes.loadFailure.title') }}</strong>
      <p>{{ t(navigationFailure.resourceFailure ? 'routes.loadFailure.resources' : 'routes.loadFailure.message') }}</p>
    </div>
    <a :href="navigationFailure.href" class="quiet-button">{{ t('routes.loadFailure.reload') }}</a>
    <button type="button" class="navigation-recovery-dismiss" @click="navigationFailure = null">{{ t('routes.loadFailure.dismiss') }}</button>
  </div>
</template>

<style scoped>
.navigation-recovery { display: flex; flex: 0 0 auto; align-items: center; gap: 16px; margin: 12px 24px; padding: 16px; background: #faf1e5; color: #6d481e; border-radius: 10px; font-size: 13px; }
.navigation-recovery > div { flex: 1; min-width: 0; }
.navigation-recovery strong { font-weight: 650; }
.navigation-recovery p { margin: 4px 0 0; line-height: 1.6; }
.navigation-recovery a { flex-shrink: 0; text-decoration: none; }
.navigation-recovery-dismiss { border: 0; padding: 8px; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.navigation-recovery :is(a, button):focus-visible { outline: 2px solid #805623; outline-offset: 3px; }
@media (max-width: 640px) { .navigation-recovery { margin: 10px 12px; flex-wrap: wrap; gap: 10px; }.navigation-recovery > div { flex-basis: 100%; } }
</style>
