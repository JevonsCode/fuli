// Sharing the leads of the projects both computers have, once per pairing.
//
// Confirming a pairing (the 6 digits on each computer, or joining with an
// invitation) is the person's consent, said before they confirm, to share the
// leads of at most AUTO_SHARE_LIMIT projects the other computer reports having
// too (the same own repository, matched on the coordinator). It happens only in
// a group of exactly these two computers: a share is published to the whole
// group, so with a third computer the person shares with one click instead,
// told that the others can ask too. More matches than the limit share nothing
// and leave the same one click, with the number in front of the person.
//
// What counts as an answer: the coordinator holds both computers' digests
// under its current key (a coordinator that moved its listener has a new key,
// and the other computer sends its digests again only at its next publish).
// Until then it asks again every attemptMs, for at most `attempts` times; only
// a real answer or that bound writes the record, which stays until the person
// turns the LAN roundtable off or revokes the device, so it runs once per
// paired device. An existing share is never changed and none is removed; a
// project the person shared or unticked since the pairing keeps their choice.
export const AUTO_SHARE_LIMIT = 8;
const ATTEMPT_MS = 10_000;
// 18 attempts 10 s apart: three minutes, three publish intervals of the other computer.
const ATTEMPTS = 18;
const RECORDS = 'autoShared';

// port: setting(key), setSetting(key, value), paired(), match(fingerprint),
// prepare(projects), sharedProjectIds(), touchedSince(projectId, since),
// writeShares(shares), afterWrite().
export function createPairingShare({ port, clock = Date.now, attemptMs = ATTEMPT_MS, attempts = ATTEMPTS, onError = () => {} }) {
  // One waiting timer per device, and the pairing (its `since`) an attempt is
  // running for: a new pairing of the same device runs its own attempt, and
  // the older one stops at its next check, so nothing waits on a stale run.
  const timers = new Map();
  const running = new Map();
  const records = () => port.setting(RECORDS) ?? {};
  const write = (fingerprint, record) => port.setSetting(RECORDS, { ...records(), [fingerprint]: record });

  // A new pairing with this device: nothing happens when it already ran.
  function start(fingerprint) {
    if (records()[fingerprint]) return;
    cancel(fingerprint);
    const since = clock();
    write(fingerprint, { state: 'pending', since, until: since + attemptMs * (attempts - 1) });
    return attempt(fingerprint);
  }

  function cancel(fingerprint) {
    clearTimeout(timers.get(fingerprint));
    timers.delete(fingerprint);
  }

  function later(fingerprint) {
    cancel(fingerprint);
    const timer = setTimeout(() => {
      timers.delete(fingerprint);
      attempt(fingerprint).catch(onError);
    }, attemptMs);
    timer.unref?.();
    timers.set(fingerprint, timer);
  }

  const pending = (fingerprint, since) => {
    const record = records()[fingerprint];
    return record?.state === 'pending' && (since === undefined || record.since === since) ? record : null;
  };
  // Still this pairing, still paired: checked after every wait.
  const current = (fingerprint, record) => Boolean(pending(fingerprint, record.since)) && port.paired();

  async function attempt(fingerprint) {
    const record = pending(fingerprint);
    if (!record || running.get(fingerprint) === record.since || !port.paired()) return;
    running.set(fingerprint, record.since);
    try {
      const match = await port.match(fingerprint);
      if (!current(fingerprint, record)) return;
      if (!match.settled) return waitMore(fingerprint, record);
      if (match.others > 0) return finish(fingerprint, record, { projects: [], skipped: 'group', matched: match.common.length });
      if (match.common.length > AUTO_SHARE_LIMIT) {
        return finish(fingerprint, record, { projects: [], skipped: 'too_many', matched: match.common.length });
      }
      const fresh = (project) => !port.sharedProjectIds().has(project.projectId) && !port.touchedSince(project.projectId, record.since);
      const prepared = await port.prepare(match.common.filter(fresh));
      if (!current(fingerprint, record)) return;
      // The group is read again: a device that joined while the shares were prepared would see them too.
      const again = await port.match(fingerprint);
      // Checked again right before writing, with no wait in between: a revoke, a
      // turn-off or the person's own save may have come meanwhile.
      if (!current(fingerprint, record)) return;
      if (!again.settled) return waitMore(fingerprint, record);
      if (again.others > 0) return finish(fingerprint, record, { projects: [], skipped: 'group', matched: match.common.length });
      const added = prepared.filter((entry) => fresh(entry.share));
      if (added.length) port.writeShares(added.map((entry) => entry.share));
      finish(fingerprint, record, { projects: added.map(({ share, projectName }) => ({ projectId: share.projectId, projectName })) });
      if (added.length) await port.afterWrite();
    } finally { if (running.get(fingerprint) === record.since) running.delete(fingerprint); }
  }

  function waitMore(fingerprint, record) {
    if (clock() < record.until) later(fingerprint);
    else finish(fingerprint, record, { projects: [], skipped: 'unanswered' });
  }

  function finish(fingerprint, record, outcome) {
    write(fingerprint, { state: 'done', since: record.since, at: new Date(clock()).toISOString(), ...outcome });
  }

  // After a restart a pairing still waiting for its answer asks again.
  function resume() {
    for (const fingerprint of Object.keys(records())) if (pending(fingerprint)) attempt(fingerprint).catch(onError);
  }

  // A device revoked here or that left: its record and its waiting end.
  function forget(fingerprint) {
    cancel(fingerprint);
    const { [fingerprint]: gone, ...rest } = records();
    if (gone) port.setSetting(RECORDS, Object.keys(rest).length ? rest : null);
  }

  // The LAN roundtable turned off: every record and every waiting end.
  function clear() {
    close();
    port.setSetting(RECORDS, null);
  }

  // What each finished pairing shared without a separate tick, or why it shared nothing.
  const view = () => Object.entries(records()).filter(([, record]) => record.state === 'done')
    .map(([nodeId, record]) => ({ nodeId, at: record.at, projects: record.projects,
      ...(record.skipped ? { skipped: record.skipped, matched: record.matched ?? 0 } : {}) }));

  // A pairing still waiting for the coordinator's answer, so the card keeps reading status.
  const waiting = () => Object.keys(records()).some((fingerprint) => pending(fingerprint));

  function close() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { start, resume, forget, clear, view, waiting, close };
}
