// The FULI brand for every console view, in one place: the mark, the wordmark
// and the mark's data the loading draws, with the brand's motion stylesheet.
// All are generated from brand/ by scripts/build-brand-assets.js; change them
// there (brand/README.md). The mark's ink, gold and white are the logo's own
// palette and stay out of the interface tokens.
import type { AppLocale } from '@/i18n'
import mark from '../../assets/brand/fuli-mark.json'
import wordmarkEn from '../../assets/brand/fuli-wordmark-en.svg'
import wordmarkZh from '../../assets/brand/fuli-wordmark-zh.svg'
import '../../assets/brand/fuli-motion.css'

/** The full-colour master mark, for images drawn at 28 px and up. */
export { default as fuliMarkUrl } from '../../assets/brand/fuli-mark-color.svg'

/** The wordmark for the interface language: 复利 in Chinese, FULI in English. */
export const fuliWordmarkUrl = (locale: AppLocale): string => (locale === 'zh-CN' ? wordmarkZh : wordmarkEn)

export type FuliMarkCut = 'master' | 'micro'
type GoldStop = [offset: number, color: string]

/** The mark's layers, golds and colours on its 512 view box (brand/svg/mark). */
export const FULI_MARK = mark as typeof mark & { gold: { light: GoldStop[], dark: GoldStop[] } }

/** The optical cut for a mark drawn at [pixels]: micro below 28 px, master from 28 px. */
export const markCut = (pixels: number): FuliMarkCut => (pixels < mark.microBelowPx ? 'micro' : 'master')
