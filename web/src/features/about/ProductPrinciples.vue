<script setup lang="ts">
import { computed } from 'vue'

import { t } from '@/i18n'

const principles = computed(() => [
  {
    key: 'capture',
    index: t('about.philosophy.capture.index'),
    title: t('about.philosophy.capture.title'),
    description: t('about.philosophy.capture.description'),
  },
  {
    key: 'project',
    index: t('about.philosophy.project.index'),
    title: t('about.philosophy.project.title'),
    description: t('about.philosophy.project.description'),
  },
  {
    key: 'review',
    index: t('about.philosophy.review.index'),
    title: t('about.philosophy.review.title'),
    description: t('about.philosophy.review.description'),
  },
  {
    key: 'reuse',
    index: t('about.philosophy.reuse.index'),
    title: t('about.philosophy.reuse.title'),
    description: t('about.philosophy.reuse.description'),
  },
])

const boundaries = computed(() => [
  {
    key: 'local',
    title: t('about.philosophy.local.title'),
    description: t('about.philosophy.local.description'),
  },
  {
    key: 'authority',
    title: t('about.philosophy.authority.title'),
    description: t('about.philosophy.authority.description'),
  },
  {
    key: 'scope',
    title: t('about.philosophy.scope.title'),
    description: t('about.philosophy.scope.description'),
  },
])
</script>

<template>
  <section class="product-principles" aria-labelledby="principles-title">
    <header class="principles-heading">
      <span class="principles-index" aria-hidden="true">01</span>
      <div>
        <h2 id="principles-title">{{ t('about.philosophy.sectionTitle') }}</h2>
        <p>{{ t('about.philosophy.support') }}</p>
      </div>
    </header>

    <div class="principle-sequence">
      <article v-for="principle in principles" :key="principle.key">
        <span>{{ principle.index }}</span>
        <div>
          <h3>{{ principle.title }}</h3>
          <p>{{ principle.description }}</p>
        </div>
      </article>
    </div>

    <div class="principle-boundaries">
      <h3>{{ t('about.philosophy.boundariesTitle') }}</h3>
      <div>
        <article v-for="boundary in boundaries" :key="boundary.key">
          <i :data-boundary="boundary.key" aria-hidden="true" />
          <h4>{{ boundary.title }}</h4>
          <p>{{ boundary.description }}</p>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.product-principles {
  min-width: 0;
}

.principles-heading {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  padding-bottom: 30px;
  border-bottom: 1px solid var(--color-border);
}

.principles-index {
  padding-top: 6px;
  color: var(--about-gold);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: .08em;
}

.principles-heading h2 {
  margin: 0;
  color: var(--color-ink);
  font-size: clamp(22px, 3vw, 30px);
  font-weight: 650;
  letter-spacing: -.03em;
  line-height: 1.2;
}

.principles-heading p {
  max-width: 680px;
  margin-top: 10px;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.7;
}

.principle-sequence {
  display: grid;
}

.principle-sequence article {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-content: start;
  gap: 16px;
  padding: 22px 0;
  border-bottom: 1px solid var(--color-border);
}

.principle-sequence article > span {
  padding-top: 3px;
  color: var(--about-gold);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: .06em;
}

.principle-sequence h3,
.principle-boundaries h4 {
  margin: 0;
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 680;
}

.principle-sequence p,
.principle-boundaries p {
  margin-top: 9px;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.7;
}

.principle-boundaries {
  padding-top: 30px;
}

.principle-boundaries > h3 {
  margin: 0;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 650;
}

.principle-boundaries > div {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 18px;
}

.principle-boundaries article {
  min-width: 0;
  padding: 0 20px;
}

.principle-boundaries article:first-child { padding-left: 0; }
.principle-boundaries article:last-child { padding-right: 0; }
.principle-boundaries article + article { border-left: 1px solid var(--color-border); }

.principle-boundaries i {
  width: 8px;
  height: 8px;
  display: inline-block;
  margin-bottom: 12px;
  border: 1.5px solid var(--color-muted);
  border-radius: 50%;
}

.principle-boundaries i[data-boundary="authority"] { border-radius: 2px; }
.principle-boundaries i[data-boundary="scope"] { transform: rotate(45deg); border-radius: 1px; }

@media (max-width: 680px) {
  .principles-heading { gap: 12px; }
  .principle-sequence article { gap: 12px; padding: 20px 0; }
  .principle-boundaries > div { grid-template-columns: 1fr; gap: 20px; }
  .principle-boundaries article { padding: 0; }
  .principle-boundaries article + article { padding-top: 20px; border-top: 1px solid var(--color-border); border-left: 0; }
}
</style>
