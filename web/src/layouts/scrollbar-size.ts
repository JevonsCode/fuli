// The page scrolls inside .view, and its scrollbar takes room from the page's
// right edge (none with overlay scrollbars). The top bar and the fixed
// controls read that room as --scrollbar-size, so every edge stays on the
// page's. Measured once with the app's own scrollbar style.
export function measureScrollbarSize(root: HTMLElement = document.documentElement) {
  const probe = document.createElement('div')
  probe.style.cssText = 'position: absolute; top: -200px; width: 100px; height: 100px; overflow: scroll; visibility: hidden'
  document.body.append(probe)
  root.style.setProperty('--scrollbar-size', `${probe.offsetWidth - probe.clientWidth}px`)
  probe.remove()
}
