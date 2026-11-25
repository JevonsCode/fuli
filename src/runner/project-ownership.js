import { immediateTransaction } from '../../packages/roundtable/src/storage/database-format.js';
import { grantScope } from './scope-grants.js';

const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validProject = project => typeof project === 'string' && grantScope(`project:${project}`) === `project:${project}`;
const operationId = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
const refuse = code => ({ ok: false, code });

// Only the host writes this registry. The inventory reader first verifies a
// full snapshot against owner-only exports. A missing project in a subsequent
// snapshot cannot release a project or a reservation left by an interrupted write.
export function projectOwnership(store, space) {
  const db = store.db;
  if (typeof space !== 'string' || !space) throw new TypeError('Ownership requires a personal space');
  const at = () => new Date(store.now()).toISOString();
  const owner = project => db.prepare(`SELECT project,owner,generation,state,operation,verified_at AS verifiedAt
    FROM project_owners WHERE space=? AND project=?`).get(space, project) ?? null;
  function expect(device) {
    if (!fingerprint(device)) throw new TypeError('Ownership needs a full device fingerprint');
    db.prepare('INSERT OR IGNORE INTO owner_inventory(space,fingerprint) VALUES(?,?)').run(space, device);
  }
  function claim(device, project, verifiedAt) {
    db.prepare(`INSERT INTO project_claims VALUES(?,?,?,?) ON CONFLICT(space,project,fingerprint)
      DO UPDATE SET verified_at=coalesce(excluded.verified_at,verified_at)`).run(space, project, device, verifiedAt);
    const prior = owner(project);
    if (!prior) {
      db.prepare(`INSERT INTO project_owners VALUES(?,?,?,1,?,'inventory',?)`)
        .run(space, project, device, verifiedAt ? 'owned' : 'reserved', verifiedAt);
    } else if (prior.owner !== device) {
      db.prepare("UPDATE project_owners SET state='conflict' WHERE space=? AND project=?").run(space, project);
    } else if (verifiedAt && prior.state !== 'conflict') {
      db.prepare("UPDATE project_owners SET state='owned', verified_at=? WHERE space=? AND project=?").run(verifiedAt, space, project);
    }
  }
  const ready = () => db.prepare(`SELECT count(*) AS total,count(checked_at) AS complete
    FROM owner_inventory WHERE space=?`).get(space);
  return {
    owner, expect,
    rememberPermit(authority, device, result) {
      if (!fingerprint(authority) || !fingerprint(device) || !result?.ok || result.spaceId !== space || result.owner !== device ||
        !validProject(result.project) || !operationId(result.operation) || !Number.isSafeInteger(result.generation) ||
        result.generation < 1 || !['reserved','owned'].includes(result.state)) return refuse('reservation_invalid');
      return immediateTransaction(db, () => {
        const row = db.prepare('SELECT * FROM project_permits WHERE authority=? AND space=? AND project=?')
          .get(authority, space, result.project);
        if (row && (row.generation > result.generation || (row.generation === result.generation &&
          (row.operation !== result.operation || row.owner !== device || row.state === 'revoked')))) return refuse('reservation_changed');
        const state = row?.generation === result.generation && row.state === 'owned' ? 'owned' : result.state;
        db.prepare(`INSERT INTO project_permits VALUES(?,?,?,?,?,?,?) ON CONFLICT(authority,space,project) DO UPDATE SET
          owner=excluded.owner,generation=excluded.generation,operation=excluded.operation,state=excluded.state`)
          .run(authority, space, result.project, device, result.generation, result.operation, state);
        return { ok: true };
      });
    },
    reported(device, projects) {
      if (!Array.isArray(projects) || !projects.every(validProject)) throw new TypeError('Invalid project inventory');
      immediateTransaction(db, () => {
        expect(device);
        for (const project of projects) claim(device, project, null);
        db.prepare(`UPDATE owner_inventory SET checked_at=NULL WHERE space=? AND fingerprint=?
          AND EXISTS (SELECT 1 FROM project_claims WHERE space=? AND fingerprint=? AND verified_at IS NULL)`)
          .run(space, device, space, device);
      });
    },
    verified(device, projects) {
      if (!Array.isArray(projects) || !projects.every(validProject)) throw new TypeError('Invalid verified inventory');
      return immediateTransaction(db, () => {
        expect(device);
        const verifiedAt = at();
        for (const project of projects) claim(device, project, verifiedAt);
        // An unresolved report still occupies its ID and blocks new reservations.
        const pending = db.prepare(`SELECT 1 FROM project_claims WHERE space=? AND fingerprint=? AND verified_at IS NULL LIMIT 1`)
          .get(space, device);
        if (pending) return refuse('inventory_incomplete');
        db.prepare('UPDATE owner_inventory SET checked_at=? WHERE space=? AND fingerprint=?').run(verifiedAt, space, device);
        return { ok: true };
      });
    },
    reserve(device, project, operation) {
      if (!fingerprint(device) || !validProject(project) || !operationId(operation)) return refuse('reservation_invalid');
      return immediateTransaction(db, () => {
        const prior = owner(project);
        if (prior) {
          if (prior.state === 'conflict') return refuse('project_conflict');
          return prior.owner === device && (prior.operation === operation || prior.state === 'owned') ? { ok: true, ...prior } : refuse('project_taken');
        }
        const { total, complete } = ready();
        if (!total || total !== complete || !db.prepare('SELECT 1 FROM owner_inventory WHERE space=? AND fingerprint=? AND checked_at IS NOT NULL')
          .get(space, device)) return refuse('inventory_incomplete');
        db.prepare("INSERT INTO project_owners VALUES(?,?,?,1,'reserved',?,NULL)").run(space, project, device, operation);
        return { ok: true, ...owner(project) };
      });
    },
    confirm(device, project, operation) {
      if (!fingerprint(device) || !validProject(project) || !operationId(operation)) return refuse('reservation_invalid');
      return immediateTransaction(db, () => {
        const prior = owner(project);
        if (!prior || prior.owner !== device || prior.operation !== operation || prior.state === 'conflict') return refuse('reservation_changed');
        if (prior.state === 'reserved') claim(device, project, at());
        return { ok: true, ...owner(project) };
      });
    },
    // The coordinator calls this only after checking both participants' sealed
    // receipts. Changing the ready owner and committing the decision are atomic.
    move({ project, source, target, generation, moveId, decision }) {
      if (!validProject(project) || !fingerprint(source) || !fingerprint(target) || source === target ||
        !Number.isSafeInteger(generation) || generation < 1 || !operationId(moveId) ||
        !['preparing','committed','aborted'].includes(decision)) return refuse('move_invalid');
      return immediateTransaction(db, () => {
        const row = db.prepare('SELECT * FROM owner_moves WHERE space=? AND project=? AND move_id=?').get(space, project, moveId);
        if (row && (row.source !== source || row.target !== target || row.generation !== generation)) return refuse('move_changed');
        if (row?.decision === decision) return { ok: true, decision };
        const prior = owner(project);
        if (prior?.state !== 'owned' || prior.owner !== source || prior.generation !== generation) return refuse('owner_changed');
        if (!row) {
          if (decision !== 'preparing') return refuse('move_unknown');
          if (db.prepare("SELECT 1 FROM owner_moves WHERE space=? AND project=? AND decision='preparing'").get(space, project)) {
            return refuse('move_in_progress');
          }
          db.prepare('INSERT INTO owner_moves VALUES(?,?,?,?,?,?,?)').run(space, project, moveId, source, target, generation, decision);
        } else {
          if (row.decision !== 'preparing') return refuse('move_decided');
          db.prepare('UPDATE owner_moves SET decision=? WHERE space=? AND project=? AND move_id=?').run(decision, space, project, moveId);
          if (decision === 'committed') {
            db.prepare('UPDATE project_owners SET owner=?, generation=generation+1, operation=?, verified_at=? WHERE space=? AND project=?')
              .run(target, moveId, at(), space, project);
          }
        }
        return { ok: true, decision };
      });
    }
  };
}
