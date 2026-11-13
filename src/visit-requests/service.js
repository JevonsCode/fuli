import { randomUUID } from 'node:crypto';

import { withoutControls } from '../text/control-characters.js';
import { AUTO_ENVELOPE_RULE, postRunCheck, preRunCheck, secretCheck } from './auto-envelope.js';
import { createVisitRecords, hasResult } from './records.js';

// Requests a visitor sends to be done on this computer (seconding, 外派 C):
// the state machine, each requester's budget and what a change of its mode
// does to its requests. Every change of state is one event row written with
// it (records.js). A request is refused, or planned by the lead read-only and
// then, by the requester's mode, waits for the owner (plan, and auto outside
// its envelope) or is approved by the rule (auto inside it, trusted). Work
// happens only in the request's own worktree and branch; FULI never merges or
// pushes, and the owner keeps or discards the branch.
//
//   received ─(ask_only / over budget)→ refused
//   received → planning → awaiting_owner ─approve→ approved
//                       └(auto envelope / trusted)→ approved
//   awaiting_owner ─decline→ declined | ─7 days→ expired | ─cancel→ cancelled
//   approved → running → awaiting_review(ready | held) | failed | cancelled | unknown (lost to a restart)
//   awaiting_review → kept (branch stays) | discarded (worktree removed, branch deleted)
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_MS = 7 * DAY_MS;
// Per requester, counted over the last 24 hours (open requests at any time).
export const VISIT_BUDGET = Object.freeze({ requestsPerDay: { peer: 5, guest: 3 }, wakeMsPerDay: 60 * 60 * 1000, open: 10 });
// Past this many refusals of one requester in a day they are no longer written, so a flood stays bounded.
const REFUSALS_KEPT_PER_DAY = 100;
const TITLE_CHARS = 160;
const WHAT_CHARS = 4000;
const AREAS = 10;
const AREA_CHARS = 200;
const REASON_CHARS = 200;
const LIST_LIMIT = 200;
const AWAITING_SHOWN = 5;
const TERMINAL_WITHOUT_RESULT = new Set(['refused', 'declined', 'expired', 'cancelled', 'failed', 'unknown']);

// store: the visitor-access store; runner: runner.js; modeOf(key): the requester's current mode.
export function createVisitRequests({ store, runner, modeOf, now = () => new Date(), idFactory = randomUUID }) {
  const records = createVisitRecords(store);
  const running = new Map();
  const lanes = new Map();
  const work = new Set();
  let closed = false;
  const at = () => now().toISOString();

  // A requester's new request. Answers { ok: true, requestId, state } or
  // { ok: false, code } (ask_only, budget_exceeded, request_invalid); the
  // refusal is decided before any wake and recorded as a refused row.
  function submit({ requester, source, projectId, agentId, projectFolder = null, request }) {
    const asked = requestText(request);
    if (!asked) return refused('request_invalid');
    const id = idFactory();
    const time = now();
    const outcome = store.transaction(() => {
      const mode = source === 'guest' ? 'ask_only' : modeOf(requester.key);
      const usage = records.usage(requester.key, new Date(time.getTime() - DAY_MS).toISOString());
      const code = mode === 'ask_only' ? 'ask_only' : overBudget(usage, source) ? 'budget_exceeded' : null;
      if (code && usage.refused >= REFUSALS_KEPT_PER_DAY) return { code };
      records.insert({ id, requesterKey: requester.key, requesterLabel: requester.label, agentName: requester.agentName ?? null,
        source, projectId, agentId, projectFolder, ...asked, mode, at: time.toISOString() });
      if (code) {
        records.move(id, { from: 'received', to: 'refused', by: 'rule', fields: { reason: code }, note: code, at: time.toISOString() });
        return { code };
      }
      records.move(id, { from: 'received', to: 'planning', by: 'system', at: time.toISOString() });
      return { code: null };
    });
    if (outcome.code) return refused(outcome.code);
    background(planRequest(id));
    return { ok: true, requestId: id, state: 'planning' };
  }

  // The read-only planning pass, then the decision the requester's mode makes.
  async function planRequest(id) {
    const signal = track(id);
    let request = records.get(id);
    let planned;
    try {
      const prepared = await runner.prepare(request);
      records.update(id, prepared, at());
      request = records.get(id);
      planned = await runner.plan(request, { signal });
    } catch (error) {
      planned = { plan: null, error: error.code ?? 'worktree_failed', ms: 0 };
    } finally { running.delete(id); }
    const decided = store.transaction(() => {
      const current = records.get(id);
      if (current?.state !== 'planning') return current;
      records.update(id, { plan: planned.plan, planError: planned.error, planningMs: planned.ms }, at());
      return decide(records.get(id));
    });
    if (decided?.state === 'approved') scheduleRun(id);
    else if (TERMINAL_WITHOUT_RESULT.has(decided?.state)) await tidy(decided);
  }

  // A planned request, by the requester's mode as it is now. trusted skips the
  // owner's approval; auto needs its pre-run check (the plan can only keep a
  // request back); anything else waits for the owner.
  function decide(request) {
    const mode = modeOf(request.requesterKey);
    const ready = Boolean(request.worktreePath);
    if (mode === 'trusted' && ready) return approveByRule(request, mode, { rule: 'trusted' });
    if (mode === 'auto') {
      const check = preRunCheck({ plan: request.plan, budgetLeft: wakeBudgetLeft(request.requesterKey) });
      if (check.ok && ready) return approveByRule(request, mode, { rule: AUTO_ENVELOPE_RULE, checks: check.checks });
      return records.move(request.id, { from: 'planning', to: 'awaiting_owner', by: 'rule', rule: AUTO_ENVELOPE_RULE,
        checks: check.checks, at: at() });
    }
    return records.move(request.id, { from: 'planning', to: 'awaiting_owner', by: 'system', at: at() });
  }

  const approveByRule = (request, mode, { rule, checks = null }) => records.move(request.id, { from: 'planning', to: 'approved',
    by: 'rule', rule, checks, fields: { modeAtDecision: mode, decidedBy: 'rule' }, at: at() });

  // One run of a lead at a time on this computer; the roundtable's own claim
  // also waits for any other wake of that lead.
  function scheduleRun(id) {
    const { agentId } = records.get(id);
    const lane = (lanes.get(agentId) ?? Promise.resolve()).then(() => runRequest(id)).catch(() => {});
    lanes.set(agentId, lane);
    background(lane.finally(() => { if (lanes.get(agentId) === lane) lanes.delete(agentId); }));
  }

  async function runRequest(id) {
    if (closed) return;
    const approved = records.get(id);
    if (approved?.state !== 'approved') return;
    // A rule's approval holds only while the budget does; the owner's does not need it.
    if (approved.decidedBy === 'rule' && !wakeBudgetLeft(approved.requesterKey)) {
      store.transaction(() => records.move(id, { from: 'approved', to: 'awaiting_owner', by: 'rule',
        fields: { decidedBy: null, modeAtDecision: null }, note: 'budget_exceeded', at: at() }));
      return;
    }
    const signal = track(id);
    let request = store.transaction(() => records.move(id, { from: 'approved', to: 'running', by: 'system', at: at() }));
    if (!request) { running.delete(id); return; }
    let result;
    try {
      if (!request.worktreePath) {
        records.update(id, await runner.prepare(request), at());
        request = records.get(id);
      }
      result = await runner.run(request, { signal });
    } catch (error) {
      running.delete(id);
      const failed = store.transaction(() => records.move(id, { from: 'running', to: signal.aborted ? 'cancelled' : 'failed',
        by: 'system', fields: { error: error.code ?? 'run_failed', runMs: error.ms ?? 0 }, at: at() }));
      // A request cancelled meanwhile was tidied by whoever cancelled it.
      return failed ? tidy(failed) : undefined;
    }
    running.delete(id);
    store.transaction(() => records.move(id, { from: 'running', to: 'awaiting_review', ...review(request, result), at: at() }));
  }

  // ready, or held with the first reason: something outside the branch changed,
  // something that looks like a secret, or (auto) the diff left the envelope.
  function review(request, result) {
    const secrets = secretCheck(`${result.summary}\n${result.addedText}`);
    const auto = request.decidedBy === 'rule' && request.modeAtDecision === 'auto';
    const envelope = auto ? postRunCheck({ files: result.files, addedText: result.addedText }) : null;
    const holdReason = !result.intact ? 'integrity_violation' : !secrets.ok ? 'secret_found'
      : envelope && !envelope.ok ? 'outside_envelope' : null;
    return { by: 'rule', rule: auto ? AUTO_ENVELOPE_RULE : null,
      checks: [{ name: 'integrity', ok: result.intact }, ...(envelope ? envelope.checks : [secrets])],
      fields: { review: holdReason ? 'held' : 'ready', holdReason, summary: holdReason === 'secret_found' ? null : result.summary,
        files: result.files.map(({ path, added, removed }) => ({ path, added, removed })), diffstat: result.diffstat, runMs: result.ms } };
  }

  // The worktree of a request that ended without a result, and its empty branch, go.
  async function tidy(request) {
    if (!request?.worktreePath || !TERMINAL_WITHOUT_RESULT.has(request.state)) return;
    await runner.remove(request, { keepBranch: false }).catch(() => {});
  }

  function track(id) {
    const controller = new AbortController();
    running.set(id, controller);
    return controller.signal;
  }

  function background(promise) {
    const tracked = promise.catch(() => {}).finally(() => work.delete(tracked));
    work.add(tracked);
  }

  function wakeBudgetLeft(requesterKey) {
    return records.usage(requesterKey, new Date(now().getTime() - DAY_MS).toISOString()).wakeMs < VISIT_BUDGET.wakeMsPerDay;
  }

  // ---- the owner's decisions (console, loopback only) ----

  function act(id, { from, to, by = 'owner', fields = {}, note = null }) {
    const moved = store.transaction(() => {
      if (!records.get(id)) return { code: 'request_not_found' };
      return records.move(id, { from, to, by, fields, note, at: at() }) ?? { code: 'state_conflict' };
    });
    return moved.code ? refused(moved.code) : { ok: true, request: moved };
  }

  function approve(id) {
    const request = records.get(id);
    const moved = act(id, { from: 'awaiting_owner', to: 'approved',
      fields: { decidedBy: 'owner', modeAtDecision: request ? modeOf(request.requesterKey) : null } });
    if (moved.ok) scheduleRun(id);
    return moved;
  }

  async function decline(id, { reason = null } = {}) {
    const shown = typeof reason === 'string' ? [...withoutControls(reason)].slice(0, REASON_CHARS).join('').trim() || null : null;
    const moved = act(id, { from: 'awaiting_owner', to: 'declined', fields: { reason: shown } });
    if (moved.ok) await tidy(moved.request);
    return moved;
  }

  // Ends a request that has not finished; a running one is stopped.
  async function cancel(id) {
    const moved = act(id, { from: records.OPEN_STATES, to: 'cancelled' });
    if (!moved.ok) return moved;
    running.get(id)?.abort();
    await tidy(moved.request);
    return moved;
  }

  async function keep(id) {
    const moved = act(id, { from: 'awaiting_review', to: 'kept' });
    if (moved.ok) await runner.remove(moved.request, { keepBranch: true }).catch(() => {});
    return moved;
  }

  async function discard(id) {
    const moved = act(id, { from: 'awaiting_review', to: 'discarded' });
    if (moved.ok) await runner.remove(moved.request, { keepBranch: false }).catch(() => {});
    return moved;
  }

  // ---- a requester's mode and trust ----

  // Inside the port's transaction that changes the mode (port.setRequesterMode):
  // ask_only ends every request of that requester that has not finished;
  // plan returns what a rule approved and has not started to the owner.
  // Raising the mode approves nothing that is already waiting.
  function modeChanged(requesterKey, mode, note = `mode_${mode}`) {
    if (mode === 'ask_only') return endOpen(requesterKey, note);
    if (mode !== 'plan') return { cancelled: [], returned: [] };
    const returned = records.inStates(['approved'], { requesterKey }).filter((request) => request.decidedBy === 'rule')
      .map((request) => records.move(request.id, { from: 'approved', to: 'awaiting_owner', by: 'owner',
        fields: { decidedBy: null, modeAtDecision: null }, note, at: at() })).filter(Boolean).map((request) => request.id);
    return { cancelled: [], returned };
  }

  function endOpen(requesterKey, note) {
    const cancelled = records.inStates(records.OPEN_STATES, { requesterKey })
      .map((request) => records.move(request.id, { from: records.OPEN_STATES, to: 'cancelled', by: 'owner', note, at: at() }))
      .filter(Boolean).map((request) => request.id);
    return { cancelled, returned: [] };
  }

  // After that transaction committed: stop what was running and tidy up.
  async function settle({ cancelled }) {
    for (const id of cancelled) running.get(id)?.abort();
    await Promise.all(cancelled.map((id) => tidy(records.get(id))));
  }

  // A paired device the owner revoked: its share is gone, so are its open requests.
  async function requesterRevoked(requesterKey) {
    const effects = store.transaction(() => endOpen(requesterKey, 'requester_revoked'));
    await settle(effects);
    return effects;
  }

  // ---- reads ----

  // What the requester may see of its own request, and only its own:
  // state, title, the owner's one-line reason, and once there is a result the
  // summary, branch, files and diffstat; never the patch. A held result reads
  // as still waiting for the owner.
  function requesterStatus({ requesterKey, requestId }) {
    expireStale();
    const request = typeof requestId === 'string' ? records.get(requestId) : null;
    if (!request || request.requesterKey !== requesterKey) return refused('request_not_found');
    const held = request.state === 'awaiting_review' && request.review === 'held';
    const shown = { ok: true, requestId: request.id, state: held ? 'awaiting_owner' : request.state, title: request.title,
      ...(request.reason ? { reason: request.reason } : {}) };
    if (held || !hasResult(request.state)) return shown;
    return { ...shown, ...(request.review === 'ready' && request.summary ? { summary: request.summary } : {}),
      ...(request.branch ? { branch: request.branch } : {}), files: (request.files ?? []).map((file) => file.path),
      ...(request.diffstat ? { diffstat: request.diffstat } : {}) };
  }

  function list({ state = null, limit = LIST_LIMIT } = {}) {
    expireStale();
    const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), LIST_LIMIT) : LIST_LIMIT;
    return { requests: records.list({ state, limit: bounded }),
      awaiting: { count: records.count('awaiting_owner'), newest: records.list({ state: 'awaiting_owner', limit: AWAITING_SHOWN }) } };
  }

  // The owner's full card: the request, its history and, once there is a
  // result whose branch still exists, the patch.
  async function card(id) {
    expireStale();
    const request = records.get(id);
    if (!request) return refused('request_not_found');
    const diff = ['awaiting_review', 'kept'].includes(request.state) && request.branch
      ? await runner.patch(request).catch(() => null) : null;
    return { ok: true, request, events: records.events(id), diff };
  }

  // Requests that waited for the owner for 7 days end; their worktrees go.
  function expireStale() {
    if (!store.readable) return;
    const cutoff = new Date(now().getTime() - EXPIRY_MS).toISOString();
    const expired = store.transaction(() => records.inStates(['awaiting_owner']).filter((request) => request.updatedAt < cutoff)
      .map((request) => records.move(request.id, { from: 'awaiting_owner', to: 'expired', by: 'system', at: at() })).filter(Boolean));
    for (const request of expired) background(tidy(request));
  }

  // After a restart nothing of an earlier process is still being supervised:
  // a run that was going is unknown, a plan that was going waits for the owner
  // without one, and what was approved runs.
  function resume() {
    if (!store.readable) return;
    const approved = store.transaction(() => {
      for (const request of records.inStates(['running'])) {
        records.move(request.id, { from: 'running', to: 'unknown', by: 'system', fields: { error: 'restarted' }, at: at() });
      }
      for (const request of records.inStates(['planning'])) {
        records.update(request.id, { planError: 'planning_interrupted' }, at());
        records.move(request.id, { from: 'planning', to: 'awaiting_owner', by: 'system', note: 'planning_interrupted', at: at() });
      }
      return records.inStates(['approved']);
    });
    for (const request of approved) scheduleRun(request.id);
    expireStale();
  }

  async function close() {
    closed = true;
    for (const controller of running.values()) controller.abort();
    await Promise.allSettled([...work]);
  }

  return { submit, requesterStatus, list, card, approve, decline, cancel, keep, discard, modeChanged, settle,
    requesterRevoked, resume, close };
}

function overBudget(usage, source) {
  return usage.requests >= VISIT_BUDGET.requestsPerDay[source] || usage.open >= VISIT_BUDGET.open
    || usage.wakeMs >= VISIT_BUDGET.wakeMsPerDay;
}

// The requester's text as it is kept: bounded, and refused when it does not
// fit rather than cut, so the card always shows what was actually asked.
function requestText(request) {
  const { title, what, expectedAreas = [] } = request ?? {};
  const fits = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
  if (!fits(title, TITLE_CHARS) || !fits(what, WHAT_CHARS) || !Array.isArray(expectedAreas) || expectedAreas.length > AREAS
    || !expectedAreas.every((area) => fits(area, AREA_CHARS))) return null;
  return { title: title.trim(), what: what.trim(), requesterAreas: expectedAreas.map((area) => area.trim()) };
}

const refused = (code) => ({ ok: false, code });
