import { messages, sceneMessages } from './translations.js';
import { structuredData } from './metadata.js';

const STORAGE_KEY = 'fuli.site.language';
const supported = locale => locale === 'zh-CN' || locale === 'en';

export function resolveLanguage(languages = [], saved) {
  if (supported(saved)) return saved;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}

export function createLanguageController({ document, languages = [], getStorage = () => null }) {
  let saved;
  try { saved = getStorage()?.getItem(STORAGE_KEY); } catch { /* Storage is optional. */ }
  // Explicit language URLs always remain readable, even with a different saved preference.
  const pageLocale = document.documentElement.dataset.pageLocale;
  let locale = supported(pageLocale) ? pageLocale : resolveLanguage(languages, saved);
  const listeners = new Set();
  const t = key => messages[locale][key];

  function render() {
    document.documentElement.lang = locale;
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.getAttribute('data-i18n'));
    }
    // These templates come only from the bundled, authored translation dictionary.
    for (const element of document.querySelectorAll('[data-i18n-html]')) {
      element.innerHTML = t(element.getAttribute('data-i18n-html'));
    }
    for (const attribute of ['aria-label', 'content', 'href']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    for (const link of document.querySelectorAll('[data-locale]')) {
      if (link.dataset.locale === locale) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    const schema = document.querySelector('#site-schema');
    if (schema) schema.textContent = JSON.stringify(structuredData(locale, document.querySelector('link[rel="canonical"]').href));
  }

  function setLocale(value) {
    if (!supported(value)) return;
    locale = value;
    try { getStorage()?.setItem(STORAGE_KEY, locale); } catch { /* Still switch for this visit. */ }
    render();
    listeners.forEach(listener => listener(locale));
  }

  render();
  for (const link of document.querySelectorAll('[data-locale]')) {
    link.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      setLocale(link.dataset.locale);
    });
  }
  return {
    get locale() { return locale; },
    t,
    labels: scene => sceneMessages[locale][scene] ?? sceneMessages[locale].default,
    setLocale,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
