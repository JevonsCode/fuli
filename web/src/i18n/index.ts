import { createI18n } from 'vue-i18n'
import { uiMessages } from './messages/ui'
import { overviewMessages } from './messages/overview'
import { agentRedesignMessages } from './messages/agent-redesign'

import { agentProfileMessages } from './messages/agent-profiles'
import { commonMessages } from './messages/common'
import { consoleMessages } from './messages/console'
import { knowledgeDomainMessages } from './messages/knowledge-domain'
import { knowledgeDialogMessages } from './messages/knowledge-dialogs'
import { knowledgeWorkspaceMessages } from './messages/knowledge-workspace'
import { aboutMessages } from './messages/about'
import { pageMessages } from './messages/pages'
import { preferenceMessages } from './messages/preferences'
import { projectMessages } from './messages/projects'
import { projectAgentMessages } from './messages/project-agents'
import { projectHistoryMessages } from './messages/project-history'
import { routeMessages } from './messages/routes'
import { settingsMessages } from './messages/settings'
import { employeeMessages } from './messages/employees'
import { attentionMessages } from './messages/attention'
import { shellMessages } from './messages/shell'
import { occupationsMessages } from './messages/occupations'
import { agentServicesMessages } from './messages/agent-services'
import { flasMessages } from './messages/flas'
import { agentAppsMessages } from './messages/agent-apps'
import { roleNameMessages } from './messages/role-names'
import { teamWorkMessages } from './messages/team-work'
import { flaPageMessages } from './messages/fla-page'
import { agentWorkbenchMessages } from './messages/agent-workbench'
import { dataFormatMessages } from './messages/data-format'
import { modelSettingsMessages } from './messages/model-settings'
import { glossaryMessages } from './messages/glossary'
import { roundtableMessages } from './messages/roundtable'
import { agentPinsMessages } from './messages/agent-pins'
import { judgmentMessages } from './messages/judgment'
import { taskRunMessages } from './messages/task-runs'
import { knowledgeQuickEditMessages } from './messages/knowledge-quick-edit'
import { knowledgeHardDeleteMessages } from './messages/knowledge-hard-delete'
import { sessionRecordsMessages } from './messages/session-records'
import { sessionMigrationMessages } from './messages/session-migration'
import { knowledgeTagsMessages } from './messages/knowledge-tags'
import { captureMessages } from './messages/capture'
import { clientLinksMessages } from './messages/client-links'
import { taskBlockerMessages } from './messages/task-blocker'
import { taskReasonMessages } from './messages/task-reason'
import { doctorMessages } from './messages/doctor'

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
    judgment: judgmentMessages['zh-CN'],
    agentPins: agentPinsMessages['zh-CN'],
    ui: uiMessages['zh-CN'],
    overview: overviewMessages['zh-CN'],
    agentRedesign: agentRedesignMessages['zh-CN'],
    agentProfiles: agentProfileMessages['zh-CN'],
    attention: attentionMessages['zh-CN'],
    shell: shellMessages['zh-CN'],
    occupations: occupationsMessages['zh-CN'],
    agentServices: agentServicesMessages['zh-CN'],
    flas: flasMessages['zh-CN'],
    agentApps: agentAppsMessages['zh-CN'],
    roleNames: roleNameMessages['zh-CN'],
    teamWork: teamWorkMessages['zh-CN'],
    flaPage: flaPageMessages['zh-CN'],
    agentWorkbench: agentWorkbenchMessages['zh-CN'],
    dataFormat: dataFormatMessages['zh-CN'],
    modelSettings: modelSettingsMessages['zh-CN'],
    glossary: glossaryMessages['zh-CN'],
    roundtable: roundtableMessages['zh-CN'],
    taskRuns: taskRunMessages['zh-CN'],
    knowledgeQuickEdit: knowledgeQuickEditMessages['zh-CN'],
    knowledgeHardDelete: knowledgeHardDeleteMessages['zh-CN'],
    sessionRecords: sessionRecordsMessages['zh-CN'],
    sessionMigration: sessionMigrationMessages['zh-CN'],
    knowledgeTags: knowledgeTagsMessages['zh-CN'],
    capture: captureMessages['zh-CN'],
    clientLinks: clientLinksMessages['zh-CN'],
    taskBlocker: taskBlockerMessages['zh-CN'],
    taskReason: taskReasonMessages['zh-CN'],
    doctor: doctorMessages['zh-CN'],
    employees: employeeMessages['zh-CN'],
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
    projectAgents: projectAgentMessages['zh-CN'],
    projectHistory: projectHistoryMessages['zh-CN'],
    routes: routeMessages['zh-CN'],
    settings: settingsMessages['zh-CN'],
  },
  'en-US': {
    judgment: judgmentMessages['en-US'],
    agentPins: agentPinsMessages['en-US'],
    ui: uiMessages['en-US'],
    overview: overviewMessages['en-US'],
    agentRedesign: agentRedesignMessages['en-US'],
    agentProfiles: agentProfileMessages['en-US'],
    attention: attentionMessages['en-US'],
    shell: shellMessages['en-US'],
    occupations: occupationsMessages['en-US'],
    agentServices: agentServicesMessages['en-US'],
    flas: flasMessages['en-US'],
    agentApps: agentAppsMessages['en-US'],
    roleNames: roleNameMessages['en-US'],
    teamWork: teamWorkMessages['en-US'],
    flaPage: flaPageMessages['en-US'],
    agentWorkbench: agentWorkbenchMessages['en-US'],
    dataFormat: dataFormatMessages['en-US'],
    modelSettings: modelSettingsMessages['en-US'],
    glossary: glossaryMessages['en-US'],
    roundtable: roundtableMessages['en-US'],
    taskRuns: taskRunMessages['en-US'],
    knowledgeQuickEdit: knowledgeQuickEditMessages['en-US'],
    knowledgeHardDelete: knowledgeHardDeleteMessages['en-US'],
    sessionRecords: sessionRecordsMessages['en-US'],
    sessionMigration: sessionMigrationMessages['en-US'],
    knowledgeTags: knowledgeTagsMessages['en-US'],
    capture: captureMessages['en-US'],
    clientLinks: clientLinksMessages['en-US'],
    taskBlocker: taskBlockerMessages['en-US'],
    taskReason: taskReasonMessages['en-US'],
    doctor: doctorMessages['en-US'],
    employees: employeeMessages['en-US'],
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
    projectAgents: projectAgentMessages['en-US'],
    projectHistory: projectHistoryMessages['en-US'],
    routes: routeMessages['en-US'],
    settings: settingsMessages['en-US'],
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
