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
  const timers = new Set();
  const running = new Set();
  const records = () => port.setting(RECORDS) ?? {};
  const write = (fingerprint, record) => port.setSetting(RECORDS, { ...records(), [fingerprint]: record });

  // A new pairing with this device: nothing happens when it already ran.
  function start(fingerprint) {
    if (records()[fingerprint]) return;
    const since = clock();
    write(fingerprint, { state: 'pending', since, until: since + attemptMs * (attempts - 1) });
    return attempt(fingerprint);
  }

  function later(fingerprint) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      attempt(fingerprint).catch(onError);
    }, attemptMs);
    timer.unref?.();
    timers.add(timer);
  }

  const pending = (fingerprint, since) => {
    const record = records()[fingerprint];
    return record?.state === 'pending' && (since === undefined || record.since === since) ? record : null;
  };

  async function attempt(fingerprint) {
    const record = pending(fingerprint);
    if (!record || running.has(fingerprint) || !port.paired()) return;
    running.add(fingerprint);
    try {
      const match = await port.match(fingerprint);
      if (!pending(fingerprint, record.since) || !port.paired()) return;
      if (!match.settled) {
        if (clock() < record.until) later(fingerprint);
        else finish(fingerprint, record, { projects: [], skipped: 'unanswered' });
        return;
      }
      if (match.others > 0) return finish(fingerprint, record, { projects: [], skipped: 'group', matched: match.common.length });
      if (match.common.length > AUTO_SHARE_LIMIT) {
        return finish(fingerprint, record, { projects: [], skipped: 'too_many', matched: match.common.length });
      }
      const fresh = (project) => !port.sharedProjectIds().has(project.projectId) && !port.touchedSince(project.projectId, record.since);
      const prepared = await port.prepare(match.common.filter(fresh));
      // Read again right before writing: a revoke, a turn-off or the person's own save may have come meanwhile.
      if (!pending(fingerprint, record.since) || !port.paired()) return;
      const added = prepared.filter((entry) => fresh(entry.share));
      if (added.length) port.writeShares(added.map((entry) => entry.share));
      finish(fingerprint, record, { projects: added.map(({ share, projectName }) => ({ projectId: share.projectId, projectName })) });
      if (added.length) await port.afterWrite();
    } finally { running.delete(fingerprint); }
  }

  function finish(fingerprint, record, outcome) {
    write(fingerprint, { state: 'done', since: record.since, at: new Date(clock()).toISOString(), ...outcome });
  }

  // After a restart a pairing still waiting for its answer asks again.
  function resume() {
    for (const fingerprint of Object.keys(records())) if (pending(fingerprint)) attempt(fingerprint).catch(onError);
  }

  function forget(fingerprint) {
    const { [fingerprint]: gone, ...rest } = records();
    if (gone) port.setSetting(RECORDS, Object.keys(rest).length ? rest : null);
  }

  // What each finished pairing shared without a separate tick, or why it shared nothing.
  const view = () => Object.entries(records()).filter(([, record]) => record.state === 'done')
    .map(([nodeId, record]) => ({ nodeId, at: record.at, projects: record.projects,
      ...(record.skipped ? { skipped: record.skipped, matched: record.matched ?? 0 } : {}) }));

  function close() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  return { start, resume, forget, view, close };
}
