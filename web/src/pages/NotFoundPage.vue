<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { t } from '@/i18n'
</script>

<template>
  <!-- The shell's H1 says the page was not found; the card says why and offers the way home. -->
  <section class="view [scrollbar-gutter:stable]">
    <Card class="mx-auto w-full max-w-(--form-max) items-start px-5" role="status">
      <p class="m-0 text-sm text-muted-foreground">{{ t('common.errors.pageNotFoundCopy') }}</p>
      <Button as-child variant="outline"><RouterLink to="/">{{ t('common.actions.backHome') }}</RouterLink></Button>
    </Card>
  </section>
</template>
