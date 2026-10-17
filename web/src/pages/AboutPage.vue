<script setup lang="ts">
import AboutSectionHeading from '@/features/about/AboutSectionHeading.vue'
import LabelGuide from '@/features/about/LabelGuide.vue'
import OpenSourceCredits from '@/features/about/OpenSourceCredits.vue'
import ProductPrinciples from '@/features/about/ProductPrinciples.vue'
import { t } from '@/i18n'

import fuliLogoUrl from '../../assets/brand/fuli-logo.png'
</script>

<template>
  <section class="view about-view" :aria-label="t('about.aria')">
    <div class="about-content">
      <header class="about-opening">
        <div class="about-brand-lockup">
          <span class="about-logo-plate">
            <img data-testid="about-opening-logo" :src="fuliLogoUrl" alt="" aria-hidden="true" />
          </span>
          <span class="about-brand-name">{{ t('common.brand') }}</span>
        </div>
        <p class="about-opening-claim">{{ t('about.philosophy.title') }}</p>
        <p class="about-opening-copy">{{ t('about.philosophy.intro') }}</p>
      </header>

      <ProductPrinciples />

      <section class="about-labels-section" aria-labelledby="about-labels-title">
        <AboutSectionHeading title-id="about-labels-title" :title="t('about.labelsIntro.title')" :description="t('about.labelsIntro.description')" />
        <LabelGuide />
      </section>

      <OpenSourceCredits />
    </div>
  </section>
</template>

<style scoped>
.about-view {
  min-height: 0;
  flex: 1 1 auto;
  padding: clamp(40px, 6vw, 72px) 28px 96px;
  color: var(--color-ink);
  background: var(--color-bg);
}

.about-content {
  width: min(760px, 100%);
  display: grid;
  gap: 72px;
  margin: 0 auto;
}

.about-opening {
  display: grid;
  justify-items: center;
  gap: 20px;
  padding: 8px 0 56px;
  border-bottom: 1px solid var(--color-border);
  text-align: center;
}

.about-brand-lockup {
  display: grid;
  justify-items: center;
  gap: 11px;
}

.about-logo-plate {
  display: grid;
  place-items: center;
  width: 68px;
  height: 68px;
  border-radius: 50%;
  background: var(--color-surface-subtle);
}

.about-logo-plate img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.about-brand-name {
  color: var(--color-accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .18em;
  text-transform: uppercase;
}

.about-opening-claim {
  max-width: 660px;
  color: var(--color-ink);
  font-size: clamp(26px, 4.2vw, 36px);
  font-weight: 650;
  letter-spacing: -.035em;
  line-height: 1.18;
  text-wrap: balance;
}

.about-opening-copy {
  max-width: 620px;
  color: var(--color-muted);
  font-size: 15px;
  line-height: 1.8;
}

.about-labels-section {
  display: grid;
  gap: 32px;
}

@media (max-width: 680px) {
  .about-view { padding: 32px 20px 64px; }
  .about-content { gap: 56px; }
  .about-opening { padding-bottom: 44px; }
  .about-opening-copy { font-size: 14px; }
}
</style>
