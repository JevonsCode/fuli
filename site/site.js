// Progressive enhancement only: the page is complete without this script.
import { createScrollScene } from './scene.js'
import { createLanguageController } from './i18n.js'

const language = createLanguageController({
  document,
  languages: navigator.languages?.length ? navigator.languages : [navigator.language],
  getStorage: () => window.localStorage,
})
// Real links also work without JavaScript; carry the current chapter across languages.
for (const link of document.querySelectorAll('.language-switch a')) {
  link.addEventListener('click', () => { link.hash = window.location.hash })
}

const nav = document.querySelector('.nav')
const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8)
window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

// The 3D story runs only with room for it and when motion is welcome.
const scene = createScrollScene({ labels: language.labels })
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const shortViewport = window.matchMedia('(max-height: 560px), (max-width: 700px) and (max-height: 740px)')
const motionToggle = document.querySelector('#motion-toggle')
let userReduced = false
function applyMotion() {
  const reduced = reducedMotion.matches || userReduced
  scene.setEnabled(!reduced && !shortViewport.matches)
  motionToggle.setAttribute('aria-pressed', String(reduced))
  motionToggle.dataset.i18n = reducedMotion.matches ? 'motion.system' : reduced ? 'motion.enable' : 'motion.reduce'
  motionToggle.textContent = language.t(motionToggle.dataset.i18n)
  motionToggle.disabled = reducedMotion.matches
}
motionToggle.hidden = false
motionToggle.addEventListener('click', () => {
  // Keep the section being read in view when the layout changes.
  const anchor = document.elementFromPoint(window.innerWidth * 0.2, window.innerHeight * 0.45)?.closest('section')
  userReduced = !userReduced
  applyMotion()
  anchor?.scrollIntoView({ block: 'start' })
})
reducedMotion.addEventListener('change', applyMotion)
shortViewport.addEventListener('change', applyMotion)
applyMotion()
language.subscribe(() => {
  applyMotion()
  scene.refresh()
})

for (const terminal of document.querySelectorAll('[data-copy]')) {
  const button = terminal.querySelector('.copy')
  const showStatus = key => {
    button.dataset.i18n = key
    button.textContent = language.t(key)
  }
  button?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(terminal.dataset.copy)
      showStatus('copy.success')
    } catch {
      showStatus('copy.error')
    }
    setTimeout(() => showStatus('copy.idle'), 1800)
  })
}

const targets = document.querySelectorAll('.principles > div, .start > *')
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('is-visible')
      observer.unobserve(entry.target)
    }
  }, { rootMargin: '0px 0px -10% 0px' })
  for (const target of targets) {
    target.classList.add('reveal')
    observer.observe(target)
  }
}
