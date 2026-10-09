<script setup lang="ts">
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
        <header class="about-section-heading">
          <span class="about-section-index" aria-hidden="true">02</span>
          <div>
            <h2 id="about-labels-title">{{ t('about.labelsIntro.title') }}</h2>
            <p>{{ t('about.labelsIntro.description') }}</p>
          </div>
        </header>
        <LabelGuide />
      </section>

      <OpenSourceCredits />
    </div>
  </section>
</template>

<style scoped>
.about-view {
  --color-bg: #111923;
  --color-surface: #182330;
  --color-surface-subtle: #202d3d;
  --color-surface-hover: #25364a;
  --color-ink: #f3f6fb;
  --color-muted: #a9b6c8;
  --color-border: #3d4b5e;
  --color-border-strong: #61728a;
  --color-control-border: #778ba7;
  --color-accent: #91b8ff;
  --color-accent-hover: #b8d1ff;
  --color-accent-soft: #203d67;
  --color-success: #7ed5a5;
  --color-success-soft: #1c3b2d;
  --color-warning: #f2c476;
  --color-warning-soft: #41331e;
  --color-danger: #f2aaa5;
  --color-danger-soft: #42282c;
  --color-on-accent: #11203a;
  --about-logo-surface: #f7f3e8;
  --about-gold: #e2bd72;
  min-height: 0;
  flex: 1 1 auto;
  padding: clamp(40px, 6vw, 72px) 28px 96px;
  color: var(--color-ink);
  background: var(--color-bg);
  color-scheme: dark;
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
  background: var(--about-logo-surface);
}

.about-logo-plate img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.about-brand-name {
  color: var(--about-gold);
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

.about-section-heading {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}

.about-section-index {
  padding-top: 6px;
  color: var(--about-gold);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: .08em;
}

.about-section-heading h2 {
  margin: 0;
  color: var(--color-ink);
  font-size: clamp(22px, 3vw, 30px);
  font-weight: 650;
  letter-spacing: -.03em;
  line-height: 1.2;
}

.about-section-heading p {
  max-width: 680px;
  margin-top: 10px;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.65;
}

@media (max-width: 680px) {
  .about-view { padding: 32px 20px 64px; }
  .about-content { gap: 56px; }
  .about-opening { padding-bottom: 44px; }
  .about-section-heading { gap: 12px; }
  .about-opening-copy { font-size: 14px; }
}
</style>
