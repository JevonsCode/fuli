<script setup lang="ts">
import { computed } from 'vue'

import fuliLogoUrl from '../../../assets/brand/fuli-logo.png'
import { t } from '@/i18n'

const credits = computed(() => [
  {
    name: 'Vue.js',
    role: t('about.credits.roles.vue'),
    logo: 'https://raw.githubusercontent.com/vuejs/docs/main/src/public/logo.svg',
    url: 'https://vuejs.org/',
  },
  {
    name: 'Vite',
    role: t('about.credits.roles.vite'),
    logo: 'https://raw.githubusercontent.com/vitejs/vite/main/docs/public/logo-without-border.svg',
    url: 'https://vite.dev/',
  },
  {
    name: 'Pinia',
    role: t('about.credits.roles.pinia'),
    logo: 'https://raw.githubusercontent.com/vuejs/pinia/v4/packages/docs/public/logo.svg',
    url: 'https://pinia.vuejs.org/',
  },
  {
    name: 'D3.js',
    role: t('about.credits.roles.d3'),
    logo: 'https://raw.githubusercontent.com/d3/d3-logo/master/d3.svg',
    url: 'https://d3js.org/',
  },
  {
    name: 'Vitest',
    role: t('about.credits.roles.vitest'),
    logo: 'https://raw.githubusercontent.com/vitest-dev/vitest/main/docs/public/logo-without-border.svg',
    url: 'https://vitest.dev/',
  },
  {
    name: 'Hono',
    role: t('about.credits.roles.hono'),
    logo: 'https://raw.githubusercontent.com/honojs/website/main/public/images/logo.svg',
    url: 'https://hono.dev/',
  },
  {
    name: 'Neo4j',
    role: t('about.credits.roles.neo4j'),
    logo: 'https://avatars.githubusercontent.com/u/201120?v=4',
    url: 'https://neo4j.com/',
  },
  {
    name: 'Zod',
    role: t('about.credits.roles.zod'),
    logo: 'https://raw.githubusercontent.com/colinhacks/zod/main/packages/docs/public/logo/logo_square.png',
    url: 'https://zod.dev/',
  },
  {
    name: 'FastAPI',
    role: t('about.credits.roles.fastapi'),
    logo: 'https://raw.githubusercontent.com/fastapi/fastapi/master/docs/en/docs/img/favicon.png',
    url: 'https://fastapi.tiangolo.com/',
  },
  {
    name: 'Graphiti',
    role: t('about.credits.roles.graphiti'),
    logo: 'https://avatars.githubusercontent.com/u/132832125?s=128&v=4',
    url: 'https://github.com/getzep/graphiti',
  },
  {
    name: 'Model Context Protocol',
    role: t('about.credits.roles.mcp'),
    logo: 'https://raw.githubusercontent.com/modelcontextprotocol/docs/main/favicon.svg',
    url: 'https://modelcontextprotocol.io/',
  },
])
</script>

<template>
  <section class="open-source-credits">
    <div class="credits-roll">
      <header>
        <h3>{{ t('about.credits.title') }}</h3>
        <p>{{ t('about.credits.description') }}</p>
      </header>

      <div class="credit-grid">
        <a
          v-for="credit in credits"
          :key="credit.name"
          :href="credit.url"
          target="_blank"
          rel="noreferrer"
        >
          <span class="credit-mark">
            <img :src="credit.logo" :alt="credit.name" />
          </span>
          <span class="credit-copy">
            <strong>{{ credit.name }}</strong>
            <small>{{ credit.role }}</small>
          </span>
        </a>
      </div>

      <p class="credit-source-note">{{ t('about.credits.sourceNote') }}</p>
    </div>

    <footer class="fuli-finale">
      <div class="finale-brand">
        <img :src="fuliLogoUrl" alt="" aria-hidden="true" />
        <div>
          <strong>{{ t('common.brand') }}</strong>
          <span>Context Graph</span>
        </div>
      </div>
      <p>{{ t('about.credits.finale') }}</p>
    </footer>
  </section>
</template>

<style scoped>
.open-source-credits {
  overflow: hidden;
  border: 1px solid #d4dad5;
  border-radius: 9px;
  background: #fff;
}

.credits-roll { padding: 38px 40px 34px; }

.credits-roll header h3 {
  color: #2e3c34;
  font-size: 19px;
}

.credits-roll header p {
  margin-top: 7px;
  color: #78817b;
  font-size: 11px;
}

.credit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 28px;
  border-top: 1px solid #e1e5e1;
  border-left: 1px solid #e1e5e1;
}

.credit-grid a {
  min-width: 0;
  min-height: 118px;
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  padding: 20px;
  border-right: 1px solid #e1e5e1;
  border-bottom: 1px solid #e1e5e1;
  color: inherit;
  text-decoration: none;
}

.credit-grid a:hover { background: #f7f9f7; }
.credit-grid a:focus-visible { outline: 2px solid #7e9487; outline-offset: -2px; }

.credit-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
}

.credit-mark img {
  width: 34px;
  height: 34px;
  object-fit: contain;
}

.credit-copy { min-width: 0; display: grid; gap: 4px; }
.credit-copy strong { color: #3a463f; font-size: 11px; }
.credit-copy small { color: #89918b; font-size: 8px; }

.credit-source-note {
  max-width: 760px;
  margin-top: 18px;
  color: #929a94;
  font-size: 9px;
  line-height: 1.55;
}

.fuli-finale {
  min-height: 360px;
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 64px 32px;
  background: #222824;
  color: #f2f4f2;
  text-align: center;
}

.finale-brand {
  display: flex;
  align-items: center;
  gap: 24px;
}

.finale-brand > img {
  width: 124px;
  height: 124px;
  object-fit: contain;
  filter: grayscale(1) brightness(0) invert(1);
}

.finale-brand > div { display: grid; gap: 3px; text-align: left; }
.finale-brand strong { font-size: 34px; letter-spacing: -.04em; }
.finale-brand span { color: #aeb7b0; font-size: 13px; }

.fuli-finale > p {
  max-width: 560px;
  margin-top: 34px;
  color: #b8c0ba;
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 1180px) {
  .credits-roll { padding: 32px 28px; }
  .credit-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .credit-grid a { padding: 16px; }
}
</style>
