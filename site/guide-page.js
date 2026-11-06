// A guide page (/models/, /tech/, /guide/): language and nav only; the page is complete without it.
import { createLanguageController } from './i18n.js'

export function startGuidePage(catalog) {
  createLanguageController({
    document,
    languages: navigator.languages?.length ? navigator.languages : [navigator.language],
    getStorage: () => window.localStorage,
    catalog,
  })
  for (const link of document.querySelectorAll('.language-switch a')) {
    link.addEventListener('click', () => { link.hash = window.location.hash })
  }

  const nav = document.querySelector('.nav')
  const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8)
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}
