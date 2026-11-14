// A claim stays active until its wake ends (store.finishExecution). When the
// console restarts or crashes mid-wake nothing ends it, and the Agent could
// never be woken again (rec#97). A claim old enough that no live console still
// waits on it is released only on evidence that no process of it is running:
// the recorded process is gone, or its PID now belongs to another process, and
// on POSIX no member of its process group is left (the woken client leads its
// own group, wake.js; descendants outlive their leader). A process still
// running, a group that still answers, or an OS that cannot be asked keeps the
// hold: a woken client can outlive its console. Windows keeps no group, so the
// recorded process alone is checked there.
// A claim with no PID (its console was lost between the claim and the spawn),
// a claim written before processes were recorded, and a reused PID whose group
// still answers cannot be proven either way; they are released a day after
// they began, long after their delegation expired.

// The longest wake waits 15 minutes and is then stopped; an hour leaves margin.
export const WAKE_CLAIM_TTL_MS = 60 * 60 * 1000;
export const LEGACY_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
// A claim whose process is still running is asked about again at most this often.
const RECHECK_MS = 60 * 1000;

// inspectProcess(pids) -> Map<pid, { identity }> of the PIDs that exist, or null
// when the OS could not be asked (agent-services/process-identity.js).
// groupAlive(pgid) -> true while any process of the group exists, false when
// none does, null when the OS could not tell.
export function createWakeClaimRelease({ store, inspectProcess = async () => null, groupAlive = processGroupAlive,
  now = Date.now }) {
  const checked = new Map();

  async function released(claim) {
    const age = now() - Date.parse(claim.execution_claimed_at);
    const unproven = age >= LEGACY_CLAIM_TTL_MS;
    if (claim.wake_process_evidence !== '1' || !claim.wake_pid) return unproven;
    const ended = await recordedProcessEnded({ pid: Number(claim.wake_pid), identity: claim.wake_pid_identity },
      { inspectProcess, groupAlive });
    return ended === true || (ended === 'reused' && unproven);
  }

  // Releases what the evidence allows; the number of claims released.
  async function release(spaceId, agentId) {
    // A remote run is ended by its device's answer (applyRemote); this device sees no process of it.
    if (String(agentId).startsWith('peer:')) return 0;
    let count = 0;
    for (const claim of store.claimsBefore(spaceId, agentId, new Date(now() - WAKE_CLAIM_TTL_MS).toISOString())) {
      if (now() - (checked.get(claim.id) ?? -Infinity) < RECHECK_MS) continue;
      checked.set(claim.id, now());
      if (await released(claim) && store.expireClaim(claim.id)) {
        count += 1;
        checked.delete(claim.id);
      }
    }
    return count;
  }

  // Recorded synchronously at spawn, so a console lost right after still knows the PID.
  function recordSpawn(askId, pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    store.recordWakeProcess(askId, pid);
    void inspectProcess([pid]).then((found) => {
      const identity = found?.get(pid)?.identity;
      if (identity) store.recordWakeProcess(askId, pid, String(identity));
    }).catch(() => {});
  }

  return { release, recordSpawn };
}

// Whether a recorded wake process has ended: true when it is gone, or its PID
// now belongs to another process, and (POSIX) no member of its group is left;
// 'reused' when its PID belongs to another process whose own group still
// answers, so it cannot be told from the woken client's descendants; false
// while it runs or when the OS cannot tell. identity: as inspectProcess read
// it at spawn, or null.
export async function recordedProcessEnded({ pid, identity }, { inspectProcess, groupAlive = processGroupAlive }) {
  const running = await inspectProcess([pid]).catch(() => null);
  if (!running) return false;
  const current = running.get(pid);
  const reused = Boolean(current && identity && current.identity && String(current.identity) !== identity);
  if (current && !reused) return false;
  const group = groupAlive(pid);
  if (group === false) return true;
  return group === true && reused ? 'reused' : false;
}

// The woken client leads its own process group on POSIX (detached, wake.js).
// Signal 0 only asks whether any member exists.
export function processGroupAlive(pgid, { platform = process.platform, kill = process.kill } = {}) {
  if (platform === 'win32') return false;
  try {
    kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return error?.code === 'EPERM' ? true : null;
  }
}
