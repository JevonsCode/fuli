import { createI18n } from 'vue-i18n'

import { commonMessages } from './messages/common'
import { consoleMessages } from './messages/console'
import { knowledgeDomainMessages } from './messages/knowledge-domain'
import { knowledgeDialogMessages } from './messages/knowledge-dialogs'
import { knowledgeWorkspaceMessages } from './messages/knowledge-workspace'
import { aboutMessages } from './messages/about'
import { pageMessages } from './messages/pages'
import { preferenceMessages } from './messages/preferences'
import { projectMessages } from './messages/projects'
import { routeMessages } from './messages/routes'
import { settingsMessages } from './messages/settings'
import { writingTasteMessages } from './messages/writing-taste'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type AppLocale = typeof SUPPORTED_LOCALES[number]

export const LOCALE_STORAGE_KEY = 'fuli.locale'

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string'
    && SUPPORTED_LOCALES.includes(value as AppLocale)
}

export function resolveInitialLocale(
  storedLocale?: string | null,
  preferredLanguages: readonly string[] = [],
): AppLocale {
  if (isAppLocale(storedLocale)) return storedLocale
  for (const language of preferredLanguages) {
    const locale = localeForLanguage(language)
    if (locale) return locale
  }
  return 'en-US'
}

function readStoredLocale() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

function readPreferredLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (navigator.languages.length > 0) return navigator.languages
  return navigator.language ? [navigator.language] : []
}

function localeForLanguage(language: string): AppLocale | null {
  const primaryLanguage = language.trim().toLowerCase().split(/[-_]/, 1)[0]
  if (primaryLanguage === 'zh') return 'zh-CN'
  if (primaryLanguage === 'en') return 'en-US'
  return null
}

export const messages = {
  'zh-CN': {
    about: aboutMessages['zh-CN'],
    common: commonMessages['zh-CN'],
    console: consoleMessages['zh-CN'],
    knowledge: {
      dialogs: knowledgeDialogMessages['zh-CN'],
      domain: knowledgeDomainMessages['zh-CN'],
      workspace: knowledgeWorkspaceMessages['zh-CN'],
    },
    pages: pageMessages['zh-CN'],
    preferences: preferenceMessages['zh-CN'],
    projects: projectMessages['zh-CN'],
    routes: routeMessages['zh-CN'],
    settings: settingsMessages['zh-CN'],
    writingTaste: writingTasteMessages['zh-CN'],
  },
  'en-US': {
    about: aboutMessages['en-US'],
    common: commonMessages['en-US'],
    console: consoleMessages['en-US'],
    knowledge: {
      dialogs: knowledgeDialogMessages['en-US'],
      domain: knowledgeDomainMessages['en-US'],
      workspace: knowledgeWorkspaceMessages['en-US'],
    },
    pages: pageMessages['en-US'],
    preferences: preferenceMessages['en-US'],
    projects: projectMessages['en-US'],
    routes: routeMessages['en-US'],
    settings: settingsMessages['en-US'],
    writingTaste: writingTasteMessages['en-US'],
  },
} as const

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: resolveInitialLocale(readStoredLocale(), readPreferredLanguages()),
  fallbackLocale: 'zh-CN',
  messages,
})

export function currentLocale(): AppLocale {
  return resolveInitialLocale(i18n.global.locale.value)
}

export function setLocale(locale: AppLocale, options: { persist?: boolean } = {}) {
  i18n.global.locale.value = locale
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  if (options.persist === false || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Language switching should still work when browser storage is unavailable.
  }
}

export function t(
  key: string,
  values?: Record<string, string | number>,
): string {
  return values
    ? i18n.global.t(key, values)
    : i18n.global.t(key)
}

setLocale(currentLocale(), { persist: false })
