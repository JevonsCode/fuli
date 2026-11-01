<script setup lang="ts">
import AboutSectionHeading from './AboutSectionHeading.vue'
import { computed } from 'vue'

import { t } from '@/i18n'

// What FULI stands for (Jevons 11-01): each one is something the product does today.
const PRINCIPLE_KEYS = ['partners', 'retain', 'onDemand', 'authority', 'history', 'local'] as const

const principles = computed(() => PRINCIPLE_KEYS.map((key, position) => ({
  key,
  index: String(position + 1).padStart(2, '0'),
  title: t(`about.philosophy.${key}.title`),
  description: t(`about.philosophy.${key}.description`),
})))
</script>

<template>
  <section class="product-principles" aria-labelledby="principles-title">
    <AboutSectionHeading title-id="principles-title" :title="t('about.philosophy.sectionTitle')" :description="t('about.philosophy.support')" />

    <ol class="principle-list">
      <li v-for="principle in principles" :key="principle.key" :data-principle="principle.key">
        <span aria-hidden="true">{{ principle.index }}</span>
        <div>
          <h3>{{ principle.title }}</h3>
          <p>{{ principle.description }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.product-principles {
  min-width: 0;
}

/* Full width: one column on a phone, two on a laptop, three at most (two even rows of the six). */
.principle-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(max(min(100%, 300px), calc((100% - 80px) / 3)), 1fr));
  column-gap: 40px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.principle-list li {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-content: start;
  gap: 16px;
  padding: 24px 0;
  border-bottom: 1px solid var(--color-border);
}

.principle-list li > span {
  padding-top: 2px;
  color: var(--color-accent);
  font-size: var(--text-meta);
  font-weight: var(--weight-strong);
  letter-spacing: .06em;
}

.principle-list h3 {
  margin: 0;
  color: var(--color-ink);
  font-size: var(--text-card-title);
  font-weight: var(--weight-strong);
}

.principle-list p {
  margin-top: 8px;
  color: var(--color-muted);
  font-size: var(--text-body);
  line-height: 1.7;
}

@media (max-width: 680px) {
  .principle-list li { gap: 12px; padding: 20px 0; }
}
</style>
