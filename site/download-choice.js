// The download this computer can run comes first. The page ships with Windows
// first (and works so without JavaScript); on a Mac the macOS button takes the
// main style and the first place in each group of download buttons. The macOS
// build needs Apple silicon, which its label says, so an Intel Mac is told
// before it downloads; browsers cannot always tell the two Macs apart.

// Whether this browser runs on a Mac: an iPad also reports Macintosh, but has touch.
export function onMac(navigator) {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const mac = /mac/i.test(platform) || /Macintosh/.test(navigator.userAgent || '');
  return mac && !(navigator.maxTouchPoints > 1);
}

export function preferDownloadForThisComputer(document, navigator) {
  if (!onMac(navigator)) return;
  for (const mac of document.querySelectorAll('[data-download-macos]')) {
    const windows = mac.parentElement?.querySelector('[data-download-windows]');
    if (!windows) continue;
    const quiet = windows.classList.contains('button-quiet') || mac.classList.contains('button-quiet');
    if (quiet) {
      mac.classList.remove('button-quiet');
      windows.classList.add('button-quiet');
    }
    windows.before(mac);
  }
}
