import { immediateTransaction } from '../../packages/roundtable/src/storage/database-format.js';
import { GLOBAL_SCOPE, PROJECT_PREFIX, scopeName } from './routes-store.js';

// The row belongs to one pairing, not just to a reusable device certificate.
// A decision made from an old page must also match the version the person saw.
export function grantScope(value) {
  const scope = scopeName(value);
  return scope === value && (scope === GLOBAL_SCOPE || scope?.startsWith(PROJECT_PREFIX)) ? scope : null;
}

export function invitationScopes(values) {
  if (values === undefined) return ['*'];
  if (!Array.isArray(values) || values.length > 64 || !values.every(value => grantScope(value))) {
    throw new TypeError('Choose global or specific project scopes for this invitation');
  }
  return [...new Set(values)];
}

export function installGrants(db, space, fingerprint, pairing, scopes, at) {
  const insert = db.prepare(`INSERT INTO scope_grants(space,fingerprint,pairing,scope,state,version,decided_at)
    VALUES(?,?,?,?,'allowed',1,?)`);
  for (const scope of scopes) insert.run(space, fingerprint, pairing, scope, at);
}

// A null pairing marks a pre-migration row. Bind it once to the original
// configured space, in the same transaction as its wildcard. Revoked rows and
// expired or used invitations never receive that permission.
export function bindLegacyGrants(db, space, now, newPairing) {
  if (!space) return;
  immediateTransaction(db, () => {
    const at = new Date(now()).toISOString();
    db.prepare(`UPDATE invitations SET grant_space=?, grant_scopes='["*"]'
      WHERE grant_scopes IS NULL AND used_by IS NULL AND expires_at>?`).run(space, at);
    const legacy = db.prepare('SELECT fingerprint,revoked_at FROM runners WHERE grant_pairing IS NULL').all();
    for (const { fingerprint, revoked_at: revoked } of legacy) {
      const pairing = newPairing();
      db.prepare('UPDATE runners SET grant_space=?, grant_pairing=? WHERE fingerprint=?').run(space, pairing, fingerprint);
      db.prepare('INSERT OR IGNORE INTO owner_inventory(space,fingerprint) VALUES(?,?)').run(space, fingerprint);
      if (!revoked) installGrants(db, space, fingerprint, pairing, ['*'], at);
    }
  });
}

export function runnerGrants(store, space, fingerprint) {
  const db = store.db;
  const active = () => db.prepare(`SELECT grant_pairing AS pairing FROM runners
    WHERE fingerprint=? AND grant_space=? AND revoked_at IS NULL`).get(fingerprint, space)?.pairing;
  const row = (pairing, scope) => db.prepare(`SELECT scope,state,version,decided_at AS decidedAt FROM scope_grants
    WHERE space=? AND fingerprint=? AND pairing=? AND scope=?`).get(space, fingerprint, pairing, scope);
  const save = (pairing, scope, state, version, at) => {
    db.prepare(`INSERT INTO scope_grants(space,fingerprint,pairing,scope,state,version,decided_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(space,fingerprint,pairing,scope) DO UPDATE
      SET state=excluded.state, version=excluded.version, decided_at=excluded.decided_at`)
      .run(space, fingerprint, pairing, scope, state, version, at);
    return { ok: true, pairing, ...row(pairing, scope) };
  };
  return {
    pairing: active,
    allowed(scope) {
      if (!grantScope(scope)) return false;
      // One SELECT gives a consistent view even when another process re-pairs or revokes.
      return db.prepare(`SELECT g.state FROM scope_grants g JOIN runners r
        ON r.fingerprint=g.fingerprint AND r.grant_pairing=g.pairing AND r.grant_space=g.space
        WHERE g.space=? AND g.fingerprint=? AND r.revoked_at IS NULL AND g.scope IN (?, '*')
        ORDER BY (g.scope=?) DESC LIMIT 1`).get(space, fingerprint, scope, scope)?.state === 'allowed';
    },
    unrestricted() {
      return Boolean(db.prepare(`SELECT 1 FROM runners r JOIN scope_grants g ON r.grant_space=g.space
        AND r.fingerprint=g.fingerprint AND r.grant_pairing=g.pairing
        WHERE r.grant_space=? AND r.fingerprint=? AND r.revoked_at IS NULL AND g.scope='*' AND g.state='allowed'
        AND NOT EXISTS (SELECT 1 FROM scope_grants x WHERE x.space=g.space AND x.fingerprint=g.fingerprint
          AND x.pairing=g.pairing AND x.state<>'allowed')`).get(space, fingerprint));
    },
    list() {
      const pairing = active();
      if (!pairing) return { ok: false, code: 'runner_unknown' };
      return { ok: true, pairing, scopes: db.prepare(`SELECT scope,state,version,decided_at AS decidedAt FROM scope_grants
        WHERE space=? AND fingerprint=? AND pairing=? ORDER BY scope`).all(space, fingerprint, pairing) };
    },
    request(scope) {
      if (!grantScope(scope)) return { ok: false, code: 'scope_invalid' };
      return immediateTransaction(db, () => {
        const pairing = active();
        if (!pairing) return { ok: false, code: 'runner_unknown' };
        const current = row(pairing, scope) ?? row(pairing, '*');
        if (current) return { ok: true, pairing, ...current };
        const pending = db.prepare(`SELECT count(*) AS count FROM scope_grants
          WHERE space=? AND fingerprint=? AND pairing=? AND state='pending'`).get(space, fingerprint, pairing);
        if (pending.count >= 64) return { ok: false, code: 'pending_limit' };
        return save(pairing, scope, 'pending', 1, null);
      });
    },
    decide({ scope, state, pairing, version }) {
      if (!grantScope(scope) || !['allowed','revoked'].includes(state) || !pairing || !Number.isSafeInteger(version)) {
        return { ok: false, code: 'decision_invalid' };
      }
      return immediateTransaction(db, () => {
        if (active() !== pairing) return { ok: false, code: 'pairing_changed' };
        const current = row(pairing, scope);
        if ((current?.version ?? 0) !== version) return { ok: false, code: 'decision_changed' };
        return save(pairing, scope, state, version + 1, new Date(store.now()).toISOString());
      });
    }
  };
}
