import { randomUUID } from 'node:crypto';

import { withoutControls } from '../text/control-characters.js';
import { AUTO_ENVELOPE_RULE, postRunCheck, preRunCheck, runsOnOpenPaths, secretCheck } from './auto-envelope.js';
import { createVisitRecords } from './records.js';

// Requests a visitor sends to be done on this computer (seconding, 外派 C):
// the state machine, the budgets and what a change of a requester's mode
// does to its requests. Every change of state is one event row written with
// it (records.js). A request is refused, or planned by the lead read-only in
// the owner's project folder and then, by the requester's mode, waits for the
// owner (plan, and auto outside its envelope) or is approved by the rule (auto
// inside it, trusted). Only an approved request gets a worktree and branch;
// FULI never merges or pushes, and the owner keeps or discards the branch.
//
//   received ─(ask_only / over a budget / busy)→ refused
//   received → planning → awaiting_owner ─approve→ approved
//                       └(auto envelope / trusted)→ approved
//   awaiting_owner ─decline→ declined | ─7 days→ expired | ─cancel→ cancelled
//   approved → running → awaiting_review(ready | held) | failed | cancelled | unknown (lost to a restart)
//   awaiting_review → kept (branch stays) | discarded (worktree and branch removed)
//                   | ─14 days unreviewed→ expired (worktree removed, branch kept)
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_MS = 7 * DAY_MS;
const REVIEW_EXPIRY_MS = 14 * DAY_MS;
// Per requester over the last 24 hours (open requests, results waiting for
// review included, at any time); per shared project and for this whole
// computer over the last 24 hours; and planning wakes at once.
export const VISIT_BUDGET = Object.freeze({ requestsPerDay: { peer: 5, guest: 3 }, wakeMsPerDay: 60 * 60 * 1000, open: 10,
  projectPerDay: 10, computerPerDay: 20, planningAtOnce: 2 });
// Past this many refusals of one requester in a day they are no longer written, so a flood stays bounded.
const REFUSALS_KEPT_PER_DAY = 100;
const TITLE_CHARS = 160;
const WHAT_CHARS = 4000;
const AREAS = 10;
const AREA_CHARS = 200;
const REASON_CHARS = 200;
const LIST_LIMIT = 200;
const AWAITING_SHOWN = 5;
// What a requester may learn of a result's files.
const SHOWN_FILES = 50;
const SHOWN_PATH_CHARS = 200;
// The lead has no client FULI can run constrained here (only Codex, for now): nothing could run the request.
const NO_CLIENT = 'no_constrained_client';
const TERMINAL_WITHOUT_RESULT =new Set(['refused', 'declined', 'expired', 'cancelled', 'failed', 'unknown']);

// store: the visitor-access store; runner: runner.js; modeOf(key): the requester's current mode.
// leads.confirm({ projectId, agentId }) → whether that Agent still leads the shared project, as read now.
// leads.constrainedClients({ agentId }) → the lead's clients FULI can run constrained here, in order (planning and run use the first).
// leads.describe({ projectId, agentId }) → { name, responsibility } of the lead, which the runs are given as data.
export function createVisitRequests({ store, runner, modeOf, leads, platform = process.platform, now = () => new Date(),
  idFactory = randomUUID }) {
  const records = createVisitRecords(store);
  const running = new Map();
  const lanes = new Map();
  const work = new Set();
  let closed = false;
  const at = () => now().toISOString();

  // A requester's new request. Answers { ok: true, requestId, state } or
  // { ok: false, code } (ask_only, budget_exceeded, project_budget_exceeded,
  // computer_budget_exceeded, planning_busy, request_invalid); the refusal is
  // decided in one transaction before any wake and recorded as a refused row.
  function submit({ requester, source, projectId, agentId, projectFolder = null, request }) {
    const asked = requestText(request);
    if (!asked) return refused('request_invalid');
    const id = idFactory();
    const time = now();
    const since = new Date(time.getTime() - DAY_MS).toISOString();
    const outcome = store.transaction(() => {
      const mode = source === 'guest' ? 'ask_only' : modeOf(requester.key);
      const usage = records.usage(requester.key, since);
      const code = mode === 'ask_only' ? 'ask_only' : overBudget(usage, source) ? 'budget_exceeded'
        : records.acceptedSince(since, { projectId }) >= VISIT_BUDGET.projectPerDay ? 'project_budget_exceeded'
          : records.acceptedSince(since) >= VISIT_BUDGET.computerPerDay ? 'computer_budget_exceeded'
            : records.count('planning') >= VISIT_BUDGET.planningAtOnce ? 'planning_busy' : null;
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

  // The read-only planning pass in the owner's project folder, then the
  // decision the requester's mode makes. Nothing is copied before approval. A
  // lead with no client FULI can run constrained here ends the request
  // (failed, no_constrained_client), since nothing could run it.
  async function planRequest(id) {
    const { signal, finish } = track(id);
    let planned;
    let unrunnable = false;
    try {
      const request = records.get(id);
      const [client] = await leads.constrainedClients({ agentId: request.agentId }).catch(() => []);
      if (!client) unrunnable = true;
      else {
        records.update(id, { projectFolder: await runner.folder(request) }, at());
        planned = await runner.plan(records.get(id), { signal, client, lead: await leadOf(request) });
      }
    } catch (error) {
      planned = { plan: null, error: error.code ?? 'planning_failed', ms: 0 };
    } finally { finish(); }
    const decided = store.transaction(() => {
      const current = records.get(id);
      if (current?.state !== 'planning') return current;
      if (unrunnable) {
        return records.move(id, { from: 'planning', to: 'failed', by: 'system', fields: { error: NO_CLIENT, reason: NO_CLIENT },
          note: NO_CLIENT, at: at() });
      }
      records.update(id, { plan: planned.plan, planError: planned.error, planningMs: planned.ms }, at());
      return decide(records.get(id));
    });
    if (decided?.state === 'approved') scheduleRun(id);
  }

  const leadOf = (request) => leads.describe({ projectId: request.projectId, agentId: request.agentId }).catch(() => null);

  // A planned request, by the requester's mode as it is now. trusted skips the
  // owner's approval; auto needs its pre-run check (the plan can only keep a
  // request back); anything else waits for the owner. A request without a
  // verified project folder always waits.
  function decide(request) {
    const mode = modeOf(request.requesterKey);
    const folder = request.planError !== 'no_working_directory';
    if (mode === 'trusted' && folder) return approveByRule(request, mode, { rule: 'trusted' });
    if (mode === 'auto') {
      const check = preRunCheck({ plan: request.plan, budgetLeft: wakeBudgetLeft(request.requesterKey) });
      if (check.ok && folder) return approveByRule(request, mode, { rule: AUTO_ENVELOPE_RULE, checks: check.checks });
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
    // The share's Agent must still lead the project, as read just before the run.
    if (!await leads.confirm({ projectId: approved.projectId, agentId: approved.agentId }).catch(() => false)) {
      store.transaction(() => records.move(id, { from: 'approved', to: 'cancelled', by: 'system', fields: { reason: 'lead_changed' },
        note: 'lead_changed', at: at() }));
      return;
    }
    const [client] = await leads.constrainedClients({ agentId: approved.agentId }).catch(() => []);
    if (!client) {
      store.transaction(() => records.move(id, { from: 'approved', to: 'failed', by: 'system', fields: { error: NO_CLIENT, reason: NO_CLIENT },
        note: NO_CLIENT, at: at() }));
      return;
    }
    const lead = await leadOf(approved);
    const { signal, finish } = track(id);
    // Where the worktree and branch will be is recorded with the move, so a
    // restart before they exist still tidies both.
    let request = store.transaction(() => records.move(id, { from: 'approved', to: 'running', by: 'system',
      fields: runner.planned(approved), at: at() }));
    if (!request) { finish(); return; }
    let result;
    try {
      // The worktree is made only now, after the approval.
      records.update(id, await runner.prepare(request), at());
      request = records.get(id);
      result = await runner.run(request, { signal, client, lead });
    } catch (error) {
      const failed = store.transaction(() => records.move(id, { from: 'running', to: signal.aborted ? 'cancelled' : 'failed',
        by: 'system', fields: { error: error.code ?? 'run_failed', runMs: error.ms ?? 0 }, at: at() }));
      finish();
      // A request cancelled meanwhile is tidied by whoever cancelled it, once this ended.
      return failed ? tidy(failed) : undefined;
    }
    store.transaction(() => records.move(id, { from: 'running', to: 'awaiting_review', ...review(request, result), at: at() }));
    finish();
  }

  // ready, or held with the first reason: content that must not be staged,
  // something outside the branch changed (or could not be compared in time),
  // something that looks like a secret, files that can run code when the
  // branch is opened (in every mode; listed for the owner), or (auto) the diff
  // left the envelope.
  function review(request, result) {
    const secrets = secretCheck(`${result.summary}\n${result.addedText}`);
    const auto = request.decidedBy === 'rule' && request.modeAtDecision === 'auto';
    const envelope = auto && !result.hold ? postRunCheck({ files: result.files, addedText: result.addedText, platform }) : null;
    // In every mode: files that can run code when the branch is opened, checked out or built.
    const runsOnOpen = result.hold ? [] : runsOnOpenPaths(result.files, platform);
    const integrity = result.intact === null ? 'integrity_unknown' : result.intact ? null : 'integrity_violation';
    const holdReason = result.hold ?? integrity ?? (!secrets.ok ? 'secret_found' : runsOnOpen.length ? 'runs_on_open'
      : envelope && !envelope.ok ? 'outside_envelope' : null);
    return { by: 'rule', rule: auto ? AUTO_ENVELOPE_RULE : null,
      checks: [{ name: 'content_safe', ok: !result.hold }, { name: 'integrity', ok: result.intact === true },
        { name: 'nothing_runs_on_open', ok: runsOnOpen.length === 0 }, ...(envelope ? envelope.checks : [secrets])],
      fields: { review: holdReason ? 'held' : 'ready', holdReason, heldPaths: runsOnOpen.length ? runsOnOpen : null,
        summary: holdReason === 'secret_found' ? null : result.summary,
        files: result.files.map(({ path, added, removed }) => ({ path, added, removed })), diffstat: result.diffstat, runMs: result.ms } };
  }

  // The worktree of a request that ended without a result, and its empty branch, go.
  async function tidy(request) {
    if (!request?.worktreePath || !TERMINAL_WITHOUT_RESULT.has(request.state)) return;
    await runner.remove(request, { keepBranch: false }).catch(() => {});
  }

  // A request's wake in flight: its abort signal, and when it ended (a cancel waits for that before tidying).
  function track(id) {
    const controller = new AbortController();
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    running.set(id, { controller, done });
    return { signal: controller.signal, finish: () => { running.delete(id); finish(); } };
  }

  // Stops a request's wake and waits until its run (a commit step included) has ended.
  async function stopped(id) {
    const entry = running.get(id);
    if (!entry) return;
    entry.controller.abort();
    await entry.done;
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

  // Ends a request that has not finished; a running one is stopped, and its
  // worktree goes only once the run (its commit step included) has ended.
  async function cancel(id) {
    const moved = act(id, { from: records.OPEN_STATES, to: 'cancelled' });
    if (!moved.ok) return moved;
    await stopped(id);
    await tidy(records.get(id));
    return { ok: true, request: records.get(id) };
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

  // ---- a requester's mode, trust and shares ----

  // Inside the port's transaction that changes the mode (port.setRequesterMode):
  // ask_only ends every request of that requester that has not finished;
  // plan returns what a rule approved and has not started to the owner.
  // Raising the mode approves nothing that is already waiting.
  function modeChanged(requesterKey, mode, note = `mode_${mode}`) {
    if (mode === 'ask_only') return endOpen(records.inStates(records.OPEN_STATES, { requesterKey }), note);
    if (mode !== 'plan') return { cancelled: [], returned: [] };
    const returned = records.inStates(['approved'], { requesterKey }).filter((request) => request.decidedBy === 'rule')
      .map((request) => records.move(request.id, { from: 'approved', to: 'awaiting_owner', by: 'owner',
        fields: { decidedBy: null, modeAtDecision: null }, note, at: at() })).filter(Boolean).map((request) => request.id);
    return { cancelled: [], returned };
  }

  function endOpen(requests, note) {
    const cancelled = requests.map((request) => records.move(request.id, { from: records.OPEN_STATES, to: 'cancelled', by: 'owner',
      fields: { reason: note }, note, at: at() })).filter(Boolean).map((request) => request.id);
    return { cancelled, returned: [] };
  }

  // After that transaction committed: stop what was running, wait for it, and tidy up.
  async function settle({ cancelled }) {
    await Promise.all(cancelled.map(async (id) => {
      await stopped(id);
      await tidy(records.get(id));
    }));
  }

  // A paired device the owner revoked: its share is gone, so are its open requests.
  async function requesterRevoked(requesterKey) {
    const effects = store.transaction(() => endOpen(records.inStates(records.OPEN_STATES, { requesterKey }), 'requester_revoked'));
    await settle(effects);
    return effects;
  }

  // The shares this computer offers now ([{ projectId, agentId }]): open
  // requests to a project and lead no longer shared end (share_removed).
  async function sharesChanged(shares) {
    const offered = new Set(shares.map((share) => `${share.projectId}\n${share.agentId}`));
    const effects = store.transaction(() => endOpen(records.inStates(records.OPEN_STATES)
      .filter((request) => !offered.has(`${request.projectId}\n${request.agentId}`)), 'share_removed'));
    await settle(effects);
    return effects;
  }

  // ---- reads ----

  // What the requester may see of its own request, and only its own: state,
  // title and the owner's one-line reason. The result (summary, branch, at
  // most SHOWN_FILES cleaned paths, diffstat; never the patch) only once the
  // owner kept the branch, or, for a computer the owner marked fully trusted,
  // as soon as it is ready; a held result never shows it and reads as still
  // waiting for the owner. Reads only: nothing is written or expired here.
  function requesterStatus({ requesterKey, requestId }) {
    const request = typeof requestId === 'string' ? records.get(requestId) : null;
    if (!request || request.requesterKey !== requesterKey) return refused('request_not_found');
    const held = request.review === 'held';
    const trustedReady = request.state === 'awaiting_review' && !held && request.modeAtDecision === 'trusted'
      && request.decidedBy === 'rule';
    // A result waiting for the owner, held or not, reads like any request waiting for the owner.
    const shown = { ok: true, requestId: request.id,
      state: request.state === 'awaiting_review' && !trustedReady ? 'awaiting_owner' : request.state, title: request.title,
      ...(request.reason ? { reason: request.reason } : {}) };
    if (held || !(request.state === 'kept' || trustedReady)) return shown;
    return { ...shown, ...(request.summary ? { summary: request.summary } : {}), ...(request.branch ? { branch: request.branch } : {}),
      files: (request.files ?? []).slice(0, SHOWN_FILES).map((file) => [...withoutControls(file.path)].slice(0, SHOWN_PATH_CHARS).join('')),
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
    const diff = ['awaiting_review', 'kept', 'expired'].includes(request.state) && request.branch && request.files
      ? await runner.patch(request).catch(() => null) : null;
    return { ok: true, request, events: records.events(id), diff };
  }

  // Requests that waited for the owner for 7 days end and their worktrees go;
  // results left unreviewed for 14 days end too, their worktree removed and
  // their branch kept, so nothing of the work is deleted silently.
  function expireStale() {
    if (!store.readable) return;
    const cutoff = (ms) => new Date(now().getTime() - ms).toISOString();
    const expired = store.transaction(() => [
      ...records.inStates(['awaiting_owner']).filter((request) => request.updatedAt < cutoff(EXPIRY_MS))
        .map((request) => records.move(request.id, { from: 'awaiting_owner', to: 'expired', by: 'system', at: at() })),
      ...records.inStates(['awaiting_review']).filter((request) => request.updatedAt < cutoff(REVIEW_EXPIRY_MS))
        .map((request) => records.move(request.id, { from: 'awaiting_review', to: 'expired', by: 'system', note: 'review_expired', at: at() }))
    ].filter(Boolean));
    for (const request of expired) {
      background(request.files ? runner.remove(request, { keepBranch: true }).catch(() => {}) : tidy(request));
    }
  }

  // After a restart nothing of an earlier process is still being supervised:
  // a run that was going is unknown and its worktree goes, a plan that was
  // going waits for the owner without one, and what was approved runs.
  function resume() {
    if (!store.readable) return;
    const { approved, unknown } = store.transaction(() => {
      const lost = records.inStates(['running']).map((request) => records.move(request.id, { from: 'running', to: 'unknown',
        by: 'system', fields: { error: 'restarted' }, at: at() })).filter(Boolean);
      for (const request of records.inStates(['planning'])) {
        records.update(request.id, { planError: 'planning_interrupted' }, at());
        records.move(request.id, { from: 'planning', to: 'awaiting_owner', by: 'system', note: 'planning_interrupted', at: at() });
      }
      return { unknown: lost, approved: records.inStates(['approved']) };
    });
    for (const request of unknown) background(tidy(request));
    for (const request of approved) scheduleRun(request.id);
    expireStale();
  }

  async function close() {
    closed = true;
    for (const { controller } of running.values()) controller.abort();
    await Promise.allSettled([...work]);
  }

  return { submit, requesterStatus, list, card, approve, decline, cancel, keep, discard, modeChanged, settle,
    requesterRevoked, sharesChanged, resume, close };
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
