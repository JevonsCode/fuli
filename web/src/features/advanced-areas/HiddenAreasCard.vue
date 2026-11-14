<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { t } from '@/i18n'
import { hiddenAreas, reveal } from './advanced-areas'

// Settings › 系统's last card: the advanced areas this installation has not
// used yet, each with 显示. It is there only while one is hidden, and it is
// the last card, so nothing above it moves when it goes. Showing is for good
// and needs no confirmation. The names are on the page, so the settings
// search finds an area by them.
</script>

<template>
  <Card v-if="hiddenAreas.length" as="section" id="hidden-areas" class="settings-card" aria-labelledby="settings-hidden-areas-title" data-hidden-areas>
    <CardHeader>
      <CardTitle id="settings-hidden-areas-title" as="h2">{{ t('advancedAreas.card.title') }}</CardTitle>
      <CardDescription>{{ t('advancedAreas.card.line') }}</CardDescription>
    </CardHeader>
    <div class="setting-list">
      <div v-for="area in hiddenAreas" :key="area" class="setting-row" :data-hidden-area="area">
        <span><strong>{{ t(`advancedAreas.areas.${area}.name`) }}</strong><small>{{ t(`advancedAreas.areas.${area}.line`) }}</small></span>
        <Button type="button" variant="outline" size="sm" :data-show-area="area" @click="reveal(area)">{{ t('advancedAreas.card.show') }}</Button>
      </div>
    </div>
  </Card>
</template>
