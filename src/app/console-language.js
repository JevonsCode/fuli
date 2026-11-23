// Which of FULI's two languages this person reads it in: the console language
// they chose (system settings, consoleLanguage), else this computer's locale.
// Everything FULI writes for a person — a receipt line, a menu entry, the name
// of a project nobody named — uses the one this returns.

export const CONSOLE_LANGUAGES = Object.freeze(['zh-CN', 'en-US']);
export const DEFAULT_CONSOLE_LANGUAGE = 'zh-CN';

export function consoleLanguage(setting, systemLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  if (CONSOLE_LANGUAGES.includes(setting)) return setting;
  return /^zh\b/iu.test(systemLocale ?? '') ? 'zh-CN' : 'en-US';
}
