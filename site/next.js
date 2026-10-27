// The preview page needs only the language switch; it is complete without this script.
import { createLanguageController } from './i18n.js'

createLanguageController({
  document,
  languages: navigator.languages?.length ? navigator.languages : [navigator.language],
  getStorage: () => window.localStorage,
})
