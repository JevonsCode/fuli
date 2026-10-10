// Progressive enhancement only: the page is complete without this script.

const nav = document.querySelector('.nav')
const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8)
window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

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

const targets = document.querySelectorAll('.band > *, .principles > div, .start > *')
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
