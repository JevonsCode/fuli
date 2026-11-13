<script setup lang="ts">
import { computed } from 'vue'
import PageStack from '@/components/PageStack.vue'
import { Button } from '@/components/ui/button'
import AboutSectionHeading from '@/features/about/AboutSectionHeading.vue'
import HowtoCaseCard from '@/features/howto/HowtoCaseCard.vue'
import HowtoMoveCard from '@/features/howto/HowtoMoveCard.vue'
import { howtoContent } from '@/features/howto/howto-content'
import { currentLocale, t } from '@/i18n'
import { websitePageUrl } from '@/lib/website'

// 常用操作: what a new person says to their AI to use FULI, then real cases.
// 快速上手 opens the website's quick start (install, connect, models, help).
const content = computed(() => howtoContent(currentLocale()))
</script>

<template>
  <section class="view howto-view" :aria-label="t('howto.aria')">
    <div class="howto-content">
      <section class="howto-section" aria-labelledby="howto-moves-title">
        <AboutSectionHeading title-id="howto-moves-title" :title="t('howto.moves.title')" :description="t('howto.moves.description')">
          <template #action>
            <Button as-child variant="outline" size="sm">
              <a :href="websitePageUrl('guide', currentLocale())" target="_blank" rel="noopener noreferrer" draggable="false"
                data-howto-guide>{{ t('howto.guide') }}</a>
            </Button>
          </template>
        </AboutSectionHeading>
        <PageStack>
          <HowtoMoveCard v-for="move in content.moves" :key="move.id" :move="move" />
        </PageStack>
      </section>
      <section class="howto-section" aria-labelledby="howto-cases-title">
        <AboutSectionHeading title-id="howto-cases-title" :title="t('howto.cases.title')" :description="t('howto.cases.description')" />
        <PageStack>
          <HowtoCaseCard v-for="story in content.cases" :key="story.id" :story="story" />
        </PageStack>
      </section>
    </div>
  </section>
</template>

<style scoped>
.howto-view { padding-top: clamp(16px, 3vw, 32px); padding-bottom: 96px; color: var(--color-ink); }
/* Its sentences keep --measure (.ui-prose) when the page fills the window. A
   Chinese character is about two Latin ones wide (1ch is Inter's 0, ~0.62em),
   so 62ch holds about 38 characters a line where 72ch would hold 44. */
.howto-view:lang(zh) { --measure: 62ch; }
.howto-content { display: grid; gap: 56px; }
.howto-section { display: grid; gap: 24px; }
</style>
