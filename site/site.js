// Progressive enhancement only: the page is complete without this script.
import { createScrollScene } from './scene.js'

const nav = document.querySelector('.nav')
const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8)
window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

// The 3D story runs only with room for it and when motion is welcome.
const scene = createScrollScene()
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const shortViewport = window.matchMedia('(max-height: 560px)')
const motionToggle = document.querySelector('#motion-toggle')
let userReduced = false
function applyMotion() {
  const reduced = reducedMotion.matches || userReduced
  scene.setEnabled(!reduced && !shortViewport.matches)
  motionToggle.setAttribute('aria-pressed', String(reduced))
  motionToggle.textContent = reducedMotion.matches ? '已跟随系统减少动效' : reduced ? '体验滚动动效' : '减少动效'
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

for (const terminal of document.querySelectorAll('[data-copy]')) {
  const button = terminal.querySelector('.copy')
  button?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(terminal.dataset.copy)
      button.textContent = '已复制'
    } catch {
      button.textContent = '请手动复制'
    }
    setTimeout(() => { button.textContent = '复制' }, 1800)
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
