<script setup lang="ts">
import LabelGuide from '@/features/about/LabelGuide.vue'
import OpenSourceCredits from '@/features/about/OpenSourceCredits.vue'
import ProductPrinciples from '@/features/about/ProductPrinciples.vue'
import { t } from '@/i18n'
</script>

<template>
  <section class="view about-view" :aria-label="t('about.aria')">
    <div class="about-content">
      <ProductPrinciples />

      <section class="about-labels-section">
        <header>
          <h3>{{ t('about.labelsIntro.title') }}</h3>
          <p>{{ t('about.labelsIntro.description') }}</p>
        </header>
        <LabelGuide />
      </section>

      <OpenSourceCredits />
    </div>
  </section>
</template>

<style scoped>
.about-view {
  padding-top: 24px;
  background: #f7f8f6;
}

.about-content {
  width: min(1100px, 100%);
  display: grid;
  gap: 18px;
  margin: 0 auto;
}

.about-labels-section {
  display: grid;
  gap: 14px;
  padding-top: 22px;
}

.about-labels-section > header h3 {
  color: #2e3c34;
  font-size: 19px;
}

.about-labels-section > header p {
  max-width: 720px;
  margin-top: 7px;
  color: #78817b;
  font-size: 11px;
  line-height: 1.6;
}
</style>
