<script setup lang="ts">
import AboutSectionHeading from './AboutSectionHeading.vue'
import { computed, reactive } from 'vue'

import { t } from '@/i18n'
import { fuliMarkUrl } from '@/lib/brand'

// Logos come from each project's own repository, as before; the browser
// caches them. A logo that cannot load becomes a quiet initial tile.
const failed = reactive(new Set<string>())
const credits = computed(() => [
  {
    name: 'Vue.js',
    role: t('about.credits.roles.vue'),
    url: 'https://vuejs.org/',
    logo: 'https://raw.githubusercontent.com/vuejs/docs/main/src/public/logo.svg',
  },
  {
    name: 'Vite',
    role: t('about.credits.roles.vite'),
    url: 'https://vite.dev/',
    logo: 'https://raw.githubusercontent.com/vitejs/vite/main/docs/public/logo-without-border.svg',
  },
  {
    name: 'Pinia',
    role: t('about.credits.roles.pinia'),
    url: 'https://pinia.vuejs.org/',
    logo: 'https://raw.githubusercontent.com/vuejs/pinia/v4/packages/docs/public/logo.svg',
  },
  {
    name: 'D3.js',
    role: t('about.credits.roles.d3'),
    url: 'https://d3js.org/',
    logo: 'https://raw.githubusercontent.com/d3/d3-logo/master/d3.svg',
  },
  {
    name: 'Vitest',
    role: t('about.credits.roles.vitest'),
    url: 'https://vitest.dev/',
    logo: 'https://raw.githubusercontent.com/vitest-dev/vitest/main/docs/public/logo-without-border.svg',
  },
  {
    name: 'Hono',
    role: t('about.credits.roles.hono'),
    url: 'https://hono.dev/',
    logo: 'https://raw.githubusercontent.com/honojs/website/main/public/images/logo.svg',
  },
  {
    name: 'Neo4j',
    role: t('about.credits.roles.neo4j'),
    url: 'https://neo4j.com/',
    logo: 'https://avatars.githubusercontent.com/u/201120?v=4',
  },
  {
    name: 'Zod',
    role: t('about.credits.roles.zod'),
    url: 'https://zod.dev/',
    logo: 'https://raw.githubusercontent.com/colinhacks/zod/main/packages/docs/public/logo/logo_square.png',
  },
  {
    name: 'Inter',
    role: t('about.credits.roles.inter'),
    url: 'https://rsms.me/inter/',
    logo: 'https://github.com/rsms.png',
  },
  {
    name: 'Noto Sans SC',
    role: t('about.credits.roles.notoSansSc'),
    url: 'https://fonts.google.com/noto/specimen/Noto+Sans+SC',
    logo: 'https://github.com/notofonts.png',
  },
  {
    name: 'FastAPI',
    role: t('about.credits.roles.fastapi'),
    url: 'https://fastapi.tiangolo.com/',
    logo: 'https://raw.githubusercontent.com/fastapi/fastapi/master/docs/en/docs/img/favicon.png',
  },
  {
    name: 'Graphiti',
    role: t('about.credits.roles.graphiti'),
    url: 'https://github.com/getzep/graphiti',
    logo: 'https://avatars.githubusercontent.com/u/132832125?s=128&v=4',
  },
  {
    name: 'MCP',
    role: t('about.credits.roles.mcp'),
    url: 'https://modelcontextprotocol.io/',
    logo: 'https://raw.githubusercontent.com/modelcontextprotocol/docs/main/favicon.svg',
  },
])
</script>

<template>
  <section class="open-source-credits" aria-labelledby="credits-title">
    <AboutSectionHeading title-id="credits-title" :title="t('about.credits.title')" :description="t('about.credits.description')" />

    <ul class="credit-grid">
      <li v-for="credit in credits" :key="credit.name">
        <a class="credit-card" :href="credit.url" target="_blank" rel="noreferrer" :data-credit="credit.name">
          <span class="credit-mark" :class="{ 'is-fallback': failed.has(credit.name) }">
            <img v-if="!failed.has(credit.name)" :src="credit.logo" alt="" loading="lazy" referrerpolicy="no-referrer" @error="failed.add(credit.name)" />
            <span v-else aria-hidden="true">{{ credit.name.charAt(0) }}</span>
          </span>
          <span class="credit-copy">
            <strong :title="credit.name">{{ credit.name }}</strong>
            <small>{{ credit.role }}</small>
          </span>
          <span class="credit-arrow" aria-hidden="true">↗</span>
        </a>
      </li>
    </ul>

    <p class="credit-source-note">{{ t('about.credits.sourceNote') }}</p>

    <footer class="fuli-finale">
      <span class="finale-logo-plate">
        <img :src="fuliMarkUrl" alt="" aria-hidden="true" />
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

.credit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 24px 0 0;
  padding: 0;
  list-style: none;
}

.credit-grid > li { display: flex; }

.credit-card {
  flex: 1;
  position: relative;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 84px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  color: inherit;
  text-decoration: none;
  transition: border-color var(--motion-fast), transform var(--motion-fast) var(--motion-ease);
}

.credit-card:hover { border-color: var(--color-border-strong); transform: translateY(-2px); }
.credit-card:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.credit-mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--color-surface-subtle);
}

.credit-mark img { width: 30px; height: 30px; object-fit: contain; }
.credit-mark.is-fallback { color: var(--color-accent); background: var(--color-accent-soft); font-size: 18px; font-weight: 700; }

.credit-copy { display: grid; gap: 3px; min-width: 0; }
.credit-copy strong, .credit-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.credit-copy strong { color: var(--color-ink); font-size: 14px; font-weight: 650; line-height: 1.3; }
.credit-copy small { color: var(--color-muted); font-size: 12px; line-height: 1.4; }

.credit-arrow {
  position: absolute;
  top: 10px;
  right: 12px;
  color: var(--color-accent);
  font-size: 13px;
  opacity: 0;
  transition: opacity var(--motion-fast);
}

.credit-card:hover .credit-arrow, .credit-card:focus-visible .credit-arrow { opacity: 1; }

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
  background: var(--color-surface-subtle);
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

@media (max-width: 980px) { .credit-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .credit-card:hover { transform: none; } }
:root[data-motion="reduced"] .credit-card:hover { transform: none; }

@media (max-width: 680px) {
  .credit-grid { grid-template-columns: 1fr; }
  .credits-heading { gap: 12px; }
  .fuli-finale { margin-top: 64px; padding-top: 56px; }
}
</style>
