import { randomUUID } from 'node:crypto';

// Far longer than one Provider request (30 seconds by default): while the lease
// is live, the claimer may still be waiting for its submit to answer.
const CLAIM_LEASE_MS = 5 * 60_000;
// The first submit and one retry, both under the slot's dispatch key.
const MAX_SUBMITS = 2;

// How one schedule slot becomes one Provider task, across crashes. The slot is
// claimed in SQLite before its submit, under a lease and the slot's dispatch
// key, which is also the submit's idempotency key. A claim whose lease ran out
// (the process died, or no answer came) is reconciled by that key: a task the
// Provider already has is adopted; a task it confirms absent is submitted once
// more under the same key; an outcome that cannot be checked stays unresolved
// and is checked again after another lease, never sent blindly. A claim is
// never deleted, so a lost acknowledgement cannot become a second task.
export function createScheduleDispatch({ app, db, now }) {
  const claimer = randomUUID();
  const iso = () => now().toISOString();
  const lease = () => ({ claimedBy: claimer, at: iso(),
    leaseExpiresAt: new Date(now().getTime() + CLAIM_LEASE_MS).toISOString() });

  // The attempt is saved before this call, so a crash inside it leaves evidence.
  async function submit(schedule, run) {
    const record = changes => db().updateRun(schedule.id, run.slot, changes, iso());
    try {
      const route = await app.submitProjectAgentTask({ personalSpaceId: schedule.personalSpaceId,
        personalProjectId: schedule.personalProjectId, idempotencyKey: run.dispatchKey,
        title: schedule.body.title, objective: schedule.body.objective, workKind: schedule.body.workKind,
        requiredCapabilities: schedule.body.requiredCapabilities,
        ...(schedule.body.leadAgentId ? { leadAgentId: schedule.body.leadAgentId } : {}),
        start: schedule.body.startMode === 'queue', duration: 'one_off',
        routingReason: `Scheduled task "${schedule.body.title}" for ${run.slot}.` });
      const task = route?.task ?? route;
      const taskId = task?.taskId ?? null, status = task?.status ?? 'failed';
      record({ taskId, status, progress: 'created', lastError: null });
      return { outcome: 'created', taskId, status };
    } catch (error) {
      const code = error?.code ?? 'task_schedule_submit_failed';
      // The routing failure itself counts toward the breaker like a failed task.
      if (rejected(error)) {
        record({ status: 'failed', progress: 'rejected', lastError: code });
        return { outcome: 'failed', error: code };
      }
      record({ status: 'unresolved', progress: 'unconfirmed', lastError: code });
      return { outcome: 'unresolved', error: code };
    }
  }

  // Claims a slot and submits it, unless it is already claimed or a person paused the schedule meanwhile.
  async function claimAndSubmit(schedule, slot) {
    const run = db().claimRun(schedule.id, slot, lease());
    if (run) return submit(schedule, run);
    return { outcome: db().get(schedule.id)?.enabled ? 'already_run' : 'paused' };
  }

  async function reconcile(run) {
    if (!db().takeOverRun(run.scheduleId, run.slot, lease())) return null;
    const schedule = db().get(run.scheduleId);
    const record = changes => db().updateRun(run.scheduleId, run.slot, changes, iso());
    const settled = result => ({ scheduleId: run.scheduleId, slot: run.slot, ...result });
    let task;
    try {
      task = await app.findProjectAgentTaskByIdempotencyKey({ personalSpaceId: schedule.personalSpaceId,
        personalProjectId: schedule.personalProjectId, idempotencyKey: run.dispatchKey });
    } catch (error) {
      const code = error?.code ?? 'task_schedule_lookup_failed';
      record({ status: 'unresolved', progress: 'unconfirmed', lastError: code });
      return settled({ outcome: 'unresolved', error: code });
    }
    if (task) {
      record({ taskId: task.taskId, status: task.status, progress: 'adopted', lastError: null });
      return settled({ outcome: 'adopted', taskId: task.taskId, status: task.status });
    }
    if (run.attempts >= MAX_SUBMITS) {
      record({ status: 'failed', progress: 'not_created', lastError: 'task_schedule_not_created' });
      return settled({ outcome: 'failed', error: 'task_schedule_not_created' });
    }
    // A pause saved while the lookup was pending keeps the claim; it is reconciled after resume.
    if (!db().retryRun(run.scheduleId, run.slot, { claimedBy: claimer, at: iso() })) {
      return db().get(run.scheduleId)?.enabled ? null : settled({ outcome: 'paused' });
    }
    const sent = await submit(db().get(run.scheduleId), run);
    return settled(sent.outcome === 'created' ? { ...sent, outcome: 'retried' } : sent);
  }

  // Runs before any new slot is claimed, so a later slot never hides an earlier one.
  async function recoverAbandoned() {
    const results = [];
    for (const run of db().abandonedRuns(iso())) {
      const result = await reconcile(run);
      if (result) results.push(result);
    }
    return results;
  }

  return { claimAndSubmit, recoverAbandoned };
}

// A Provider answer that refused the task, so nothing was created. A conflict
// (409) can mean the key already has a task, so it is checked like no answer.
function rejected(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && error.status !== 409;
}
