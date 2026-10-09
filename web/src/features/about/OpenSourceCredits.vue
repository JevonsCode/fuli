<script setup lang="ts">
import { computed } from 'vue'

import fuliLogoUrl from '../../../assets/brand/fuli-logo.png'
import { t } from '@/i18n'

const credits = computed(() => [
  {
    name: 'Vue.js',
    role: t('about.credits.roles.vue'),
    url: 'https://vuejs.org/',
  },
  {
    name: 'Vite',
    role: t('about.credits.roles.vite'),
    url: 'https://vite.dev/',
  },
  {
    name: 'Pinia',
    role: t('about.credits.roles.pinia'),
    url: 'https://pinia.vuejs.org/',
  },
  {
    name: 'D3.js',
    role: t('about.credits.roles.d3'),
    url: 'https://d3js.org/',
  },
  {
    name: 'Vitest',
    role: t('about.credits.roles.vitest'),
    url: 'https://vitest.dev/',
  },
  {
    name: 'Hono',
    role: t('about.credits.roles.hono'),
    url: 'https://hono.dev/',
  },
  {
    name: 'Neo4j',
    role: t('about.credits.roles.neo4j'),
    url: 'https://neo4j.com/',
  },
  {
    name: 'Zod',
    role: t('about.credits.roles.zod'),
    url: 'https://zod.dev/',
  },
  {
    name: 'FastAPI',
    role: t('about.credits.roles.fastapi'),
    url: 'https://fastapi.tiangolo.com/',
  },
  {
    name: 'Graphiti',
    role: t('about.credits.roles.graphiti'),
    url: 'https://github.com/getzep/graphiti',
  },
  {
    name: 'Model Context Protocol',
    role: t('about.credits.roles.mcp'),
    url: 'https://modelcontextprotocol.io/',
  },
])
</script>

<template>
  <section class="open-source-credits" aria-labelledby="credits-title">
    <header class="credits-heading">
      <span class="credits-index" aria-hidden="true">03</span>
      <div>
        <h2 id="credits-title">{{ t('about.credits.title') }}</h2>
        <p>{{ t('about.credits.description') }}</p>
      </div>
    </header>

    <ul class="credit-list">
      <li v-for="credit in credits" :key="credit.name" class="credit-item">
        <a
          class="credit-row"
          :href="credit.url"
          target="_blank"
          rel="noreferrer"
        >
          <span class="credit-role">{{ credit.role }}</span>
          <span class="credit-name">
            <strong>{{ credit.name }}</strong>
            <span class="credit-arrow" aria-hidden="true">↗</span>
          </span>
        </a>
      </li>
    </ul>

    <p class="credit-source-note">{{ t('about.credits.sourceNote') }}</p>

    <footer class="fuli-finale">
      <span class="finale-logo-plate">
        <img :src="fuliLogoUrl" alt="" aria-hidden="true" />
      </span>
      <div class="finale-brand">
        <strong>{{ t('common.brand') }}</strong>
        <span>Context Graph</span>
      </div>
      <p>{{ t('about.credits.finale') }}</p>
      <a
        class="finale-site-link"
        data-testid="about-website-link"
        href="https://xn--8ovp9s.xn--m8txu.com/fuli/"
        target="_blank"
        rel="noreferrer"
      >
        {{ t('about.credits.website') }}
      </a>
    </footer>
  </section>
</template>

<style scoped>
.open-source-credits {
  min-width: 0;
}

.credits-heading {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  padding-bottom: 30px;
  border-bottom: 1px solid var(--color-border);
}

.credits-index {
  padding-top: 6px;
  color: var(--about-gold);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: .08em;
}

.credits-heading h2 {
  margin: 0;
  color: var(--color-ink);
  font-size: clamp(22px, 3vw, 30px);
  font-weight: 650;
  letter-spacing: -.03em;
  line-height: 1.2;
}

.credits-heading p {
  margin-top: 10px;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.65;
}

.credit-list {
  display: grid;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--color-border);
}

.credit-item { display: block; }

.credit-row {
  display: grid;
  grid-template-columns: minmax(0, .75fr) minmax(0, 1.25fr);
  align-items: center;
  gap: 20px;
  padding: 16px 0;
  border-bottom: 1px solid var(--color-border);
  color: inherit;
  text-decoration: none;
  transition: color var(--motion-fast), background-color var(--motion-fast);
}

.credit-row:hover {
  color: var(--color-accent-hover);
  background: var(--color-surface);
}

.credit-row:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
}

.credit-role {
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
}

.credit-name {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 650;
  text-align: right;
}

.credit-name strong {
  min-width: 0;
  overflow-wrap: anywhere;
}

.credit-arrow {
  flex: 0 0 auto;
  color: var(--about-gold);
  font-size: 16px;
  font-weight: 400;
}

.credit-source-note {
  margin-top: 18px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.55;
}

.fuli-finale {
  display: grid;
  justify-items: center;
  gap: 16px;
  margin-top: 88px;
  padding-top: 72px;
  border-top: 1px solid var(--color-border);
  text-align: center;
}

.finale-logo-plate {
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--about-logo-surface);
}

.finale-logo-plate img {
  width: 50px;
  height: 50px;
  object-fit: contain;
}

.finale-brand {
  display: grid;
  gap: 4px;
}

.finale-brand strong {
  color: var(--color-ink);
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -.03em;
}

.finale-brand span {
  color: var(--color-muted);
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.fuli-finale > p {
  max-width: 420px;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.65;
}

.finale-site-link {
  margin-top: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--color-accent);
  color: var(--color-accent);
  font-size: 13px;
  text-decoration: none;
}

.finale-site-link:hover {
  border-color: var(--color-accent-hover);
  color: var(--color-accent-hover);
}

.finale-site-link:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 5px;
}

@media (max-width: 680px) {
  .credits-heading { gap: 12px; }
  .credit-row { grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 14px; padding: 15px 0; }
  .credit-name { font-size: 14px; }
  .fuli-finale { margin-top: 64px; padding-top: 56px; }
}
</style>
