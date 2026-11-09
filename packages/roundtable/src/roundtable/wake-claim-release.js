// A claim stays active until its wake ends (store.finishExecution). When the
// console restarts or crashes mid-wake nothing ends it, and the Agent could
// never be woken again (rec#97). A claim old enough that no live console still
// waits on it is released only on evidence that no process of it is running:
// - it never started one (claimed with evidence, no process recorded);
// - the recorded process is gone, or its PID now belongs to another process.
// A process still running, or one the OS cannot be asked about, keeps the hold:
// a woken client can outlive its console (it runs in its own process group).
// Claims written before processes were recorded carry no evidence; they are
// released a day after they began, long after their delegation expired.

// The longest wake waits 15 minutes and is then stopped; an hour leaves margin.
export const WAKE_CLAIM_TTL_MS = 60 * 60 * 1000;
export const LEGACY_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
// A claim whose process is still running is asked about again at most this often.
const RECHECK_MS = 60 * 1000;

// inspectProcess(pids) -> Map<pid, { identity }> of the PIDs that exist, or null
// when the OS could not be asked (agent-services/process-identity.js).
export function createWakeClaimRelease({ store, inspectProcess = async () => null, now = Date.now }) {
  const checked = new Map();

  async function released(claim) {
    const age = now() - Date.parse(claim.execution_claimed_at);
    if (claim.wake_process_evidence !== '1') return age >= LEGACY_CLAIM_TTL_MS;
    if (!claim.wake_pid) return true;
    const pid = Number(claim.wake_pid);
    const running = await inspectProcess([pid]).catch(() => null);
    if (!running) return false;
    const current = running.get(pid);
    if (!current) return true;
    return Boolean(claim.wake_pid_identity && current.identity && String(current.identity) !== claim.wake_pid_identity);
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
