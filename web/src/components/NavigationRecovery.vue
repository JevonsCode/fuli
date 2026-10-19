<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { navigationFailure } from '@/router/navigation-recovery'
</script>

<template>
  <div v-if="navigationFailure" class="navigation-recovery" role="alert">
    <div>
      <strong>{{ t('routes.loadFailure.title') }}</strong>
      <p>{{ t(navigationFailure.resourceFailure ? 'routes.loadFailure.resources' : 'routes.loadFailure.message') }}</p>
    </div>
    <Button as-child variant="outline"><a :href="navigationFailure.href">{{ t('routes.loadFailure.reload') }}</a></Button>
    <Button variant="ghost" @click="navigationFailure = null">{{ t('routes.loadFailure.dismiss') }}</Button>
  </div>
</template>

<style scoped>
.navigation-recovery { display: flex; flex: 0 0 auto; align-items: center; gap: 16px; margin: 12px 24px; padding: 16px; background: var(--color-warning-soft); color: var(--color-warning); border-radius: 10px; font-size: 13px; }
.navigation-recovery > div { flex: 1; min-width: 0; }
.navigation-recovery strong { font-weight: 650; }
.navigation-recovery p { margin: 4px 0 0; line-height: 1.6; }
.navigation-recovery :is(a, button):focus-visible { outline: 2px solid var(--color-warning); outline-offset: 3px; }
@media (max-width: 640px) { .navigation-recovery { margin: 10px 12px; flex-wrap: wrap; gap: 10px; }.navigation-recovery > div { flex-basis: 100%; } }
</style>
