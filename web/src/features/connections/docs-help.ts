import { currentLocale } from '@/i18n'

/** A section of a docs page in the console's language, for a section's 「?」 link. */
export function docsHelpUrl(page: string, fragment: string) {
  const file = currentLocale() === 'zh-CN' ? `${page}.zh-CN.md` : `${page}.md`
  return `https://github.com/JevonsCode/fuli/blob/main/docs/${file}#${fragment}`
}
