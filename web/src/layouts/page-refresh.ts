import { onBeforeUnmount, onMounted } from 'vue'

// The top bar's 刷新 reads the page in view again, not only the console (Jevons 11-06: it
// looked like it did nothing). The shell already reads the console store and the waiting
// requests, so a page that only shows those needs nothing here. A page with reads of its own
// registers them: the shell runs them in place, so what the page shows stays up while the
// new read runs, and its drafts, scroll and selection are kept.
type Reload = () => unknown
const reloads = new Set<Reload>()

/** Registers the page's own reads with the top bar's refresh while the page is mounted. */
export function usePageRefresh(reload: Reload) {
  onMounted(() => { reloads.add(reload) })
  onBeforeUnmount(() => { reloads.delete(reload) })
}

/** Runs every registered read; settles when all have, whether they succeeded or not. */
export async function reloadPage(): Promise<void> {
  await Promise.allSettled([...reloads].map(reload => Promise.resolve().then(reload)))
}
