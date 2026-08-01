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
  <section class="product-principles">
    <header class="principles-lede">
      <h3>{{ t('about.philosophy.title') }}</h3>
      <p>{{ t('about.philosophy.intro') }}</p>
      <p>{{ t('about.philosophy.support') }}</p>
    </header>

    <div class="principle-sequence">
      <article v-for="principle in principles" :key="principle.key">
        <span>{{ principle.index }}</span>
        <div>
          <h4>{{ principle.title }}</h4>
          <p>{{ principle.description }}</p>
        </div>
      </article>
    </div>

    <div class="principle-boundaries">
      <strong>{{ t('about.philosophy.boundariesTitle') }}</strong>
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
  overflow: hidden;
  border: 1px solid #d4dad5;
  border-radius: 9px;
  background: #fff;
}

.principles-lede {
  padding: 44px 48px 38px;
}

.principles-lede h3 {
  max-width: 720px;
  color: #26352d;
  font-size: clamp(25px, 3vw, 38px);
  font-weight: 650;
  letter-spacing: -.04em;
  line-height: 1.12;
}

.principles-lede p {
  max-width: 820px;
  color: #66716a;
  font-size: 13px;
  line-height: 1.75;
}

.principles-lede h3 + p { margin-top: 24px; }
.principles-lede p + p { margin-top: 10px; }

.principle-sequence {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid #dde2de;
}

.principle-sequence article {
  min-height: 174px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-content: start;
  gap: 16px;
  padding: 28px 32px;
}

.principle-sequence article:nth-child(2n) { border-left: 1px solid #e2e6e2; }
.principle-sequence article:nth-child(n + 3) { border-top: 1px solid #e2e6e2; }

.principle-sequence article > span {
  padding-top: 3px;
  color: #98a19a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
}

.principle-sequence h4,
.principle-boundaries h4 {
  margin: 0;
  color: #344239;
  font-size: 14px;
  font-weight: 680;
}

.principle-sequence p,
.principle-boundaries p {
  margin-top: 9px;
  color: #6c766f;
  font-size: 11px;
  line-height: 1.7;
}

.principle-boundaries {
  padding: 27px 32px 30px;
  border-top: 1px solid #d9dfda;
  background: #f5f7f5;
}

.principle-boundaries > strong {
  color: #77817a;
  font-size: 9px;
  letter-spacing: .1em;
}

.principle-boundaries > div {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 18px;
}

.principle-boundaries article {
  position: relative;
  min-width: 0;
  padding: 0 24px 0 28px;
}

.principle-boundaries article:first-child { padding-left: 0; }
.principle-boundaries article + article { border-left: 1px solid #dce2dd; }

.principle-boundaries i {
  width: 8px;
  height: 8px;
  display: inline-block;
  margin-bottom: 12px;
  border: 1.5px solid #577463;
  border-radius: 50%;
}

.principle-boundaries i[data-boundary="authority"] { border-radius: 2px; }
.principle-boundaries i[data-boundary="scope"] { transform: rotate(45deg); border-radius: 1px; }

@media (max-width: 1180px) {
  .principles-lede { padding: 36px 34px 32px; }
  .principle-sequence article { padding: 24px; }
  .principle-boundaries article { padding-inline: 18px; }
}
</style>
