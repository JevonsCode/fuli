<script setup lang="ts">
import { computed } from 'vue'

import {
  currentLocale,
  setLocale,
  SUPPORTED_LOCALES,
  t,
  type AppLocale,
} from '@/i18n'

const activeLocale = computed(() => currentLocale())

const localeLabels: Record<AppLocale, string> = {
  'zh-CN': '中',
  'en-US': 'EN',
}

function selectLocale(locale: AppLocale) {
  if (locale === activeLocale.value) return
  setLocale(locale)
}
</script>

<template>
  <div class="locale-switcher" role="group" :aria-label="t('common.language.label')">
    <button
      v-for="locale in SUPPORTED_LOCALES"
      :key="locale"
      type="button"
      :lang="locale"
      :aria-label="t(locale === 'zh-CN' ? 'common.language.chinese' : 'common.language.english')"
      :aria-pressed="activeLocale === locale"
      @click="selectLocale(locale)"
    >
      {{ localeLabels[locale] }}
    </button>
  </div>
</template>
