// The FULI brand for every console view, in one place: the logo, the wordmark
// and the loading mark. The logo and wordmarks are copied from brand/ by
// scripts/build-brand-assets.js; replace them there (brand/README.md).
import type { AppLocale } from '@/i18n'
import wordmarkEn from '../../assets/brand/fuli-wordmark-en.svg'
import wordmarkZh from '../../assets/brand/fuli-wordmark-zh.svg'

export { default as fuliLogoUrl } from '../../assets/brand/fuli-logo.png'

/** The wordmark for the interface language: 复利 in Chinese, FULI in English. */
export const fuliWordmarkUrl = (locale: AppLocale): string => (locale === 'zh-CN' ? wordmarkZh : wordmarkEn)

/** The loading mark's three arcs on a 48 px grid; GrowthLoading animates them in turn. */
export const LOADING_ARCS = [
  'M24 5 A19 19 0 0 1 40.45 33.5',
  'M40.45 33.5 A19 19 0 0 1 7.55 33.5',
  'M7.55 33.5 A19 19 0 0 1 24 5',
] as const
