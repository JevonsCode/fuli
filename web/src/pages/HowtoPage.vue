<script setup lang="ts">
import { computed } from 'vue'
import PageColumns from '@/components/PageColumns.vue'
import AboutSectionHeading from '@/features/about/AboutSectionHeading.vue'
import HowtoCaseCard from '@/features/howto/HowtoCaseCard.vue'
import HowtoMoveCard from '@/features/howto/HowtoMoveCard.vue'
import { howtoContent } from '@/features/howto/howto-content'
import { currentLocale, t } from '@/i18n'

// 常用操作: what a new person says to their AI to use FULI, then real cases.
const content = computed(() => howtoContent(currentLocale()))
</script>

<template>
  <section class="view howto-view" :aria-label="t('howto.aria')">
    <div class="howto-content">
      <section class="howto-section" aria-labelledby="howto-moves-title">
        <AboutSectionHeading title-id="howto-moves-title" :title="t('howto.moves.title')" :description="t('howto.moves.description')" />
        <PageColumns>
          <HowtoMoveCard v-for="move in content.moves" :key="move.id" :move="move" />
        </PageColumns>
      </section>
      <section class="howto-section" aria-labelledby="howto-cases-title">
        <AboutSectionHeading title-id="howto-cases-title" :title="t('howto.cases.title')" :description="t('howto.cases.description')" />
        <PageColumns>
          <HowtoCaseCard v-for="story in content.cases" :key="story.id" :story="story" />
        </PageColumns>
      </section>
    </div>
  </section>
</template>

<style scoped>
.howto-view { padding-top: clamp(16px, 3vw, 32px); padding-bottom: 96px; color: var(--color-ink); }
.howto-content { display: grid; gap: 56px; }
.howto-section { display: grid; gap: 24px; }
</style>
