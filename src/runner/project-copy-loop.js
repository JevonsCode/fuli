import { projectCopyStatus, projectCopySync } from './project-copy-sync.js';

const INTERVAL = 60_000;
const VERIFY_INTERVAL = 10 * INTERVAL;

// Only an enabled host with paired devices creates this loop. Reconnection
// and confirmed owner writes make a scope eligible at the next minute tick.
export function startProjectCopies({ dataDir, spaceId, device, registry, request, personal, withLease, now = Date.now,
  interval = INTERVAL, onError = () => {} }) {
  const stop = new AbortController();
  const sync = projectCopySync({ dataDir, spaceId, request, personal, withLease, now,
    ownership: project => registry().remoteOwner(device, project) });
  let after = '';
  let running = null;
  let timer;
  async function scan() {
    const page = registry().remotePage(device, after);
    for (const row of page) {
      if (stop.signal.aborted) break;
      after = row.project;
      const receipt = projectCopyStatus(dataDir, spaceId, row).read();
      const age = now() - Date.parse(receipt?.checkedAt);
      if (receipt?.outcome === 'synced' && age >= 0 && age < VERIFY_INTERVAL) continue;
      await sync(row.project, { signal: stop.signal });
    }
    if (page.length < 50) after = '';
  }
  function tick() {
    if (stop.signal.aborted) return;
    running = scan().catch(onError).finally(() => {
      running = null;
      if (!stop.signal.aborted) {
        timer = setTimeout(tick, interval);
        timer.unref?.();
      }
    });
  }
  timer = setTimeout(tick, interval);
  timer.unref?.();
  return {
    invalidate(project) {
      const row = registry().remoteOwner(device, project);
      if (!row) return;
      const status = projectCopyStatus(dataDir, spaceId, row);
      const prior = status.read();
      if (prior) status.write(prior, { outcome: 'verification_due' });
    },
    async close() { stop.abort(); clearTimeout(timer); await running; }
  };
}
