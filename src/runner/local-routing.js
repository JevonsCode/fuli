import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { FAILED_JUDGMENT_GUIDANCE, judgmentFailure, judgmentRequest } from '../judgment/backend.js';
import { compactPreferences } from '../judgment/preference-receipt.js';
import { parseRoutingRequest, ROUTING_SELECTION_SCHEMA, routingInstructions, verifiedSelection } from '../judgment/routing.js';
import { parse, parseAnswer } from '../judgment/service.js';
import { jsonSchemaToZod } from '../mcp/tool-schema.js';
import { readModelBackendConfig } from '../model-backends/config.js';
import { createModelBackendPort } from '../model-backends/port.js';
import { compactReceipt } from '../model-backends/receipt.js';
import { createModelSecretStore } from '../model-backends/secret-store.js';
import { ModelUsageLedger } from '../model-backends/usage-ledger.js';
import { sha256Bytes } from '../security/digest.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { envelope, failure, projectPreferences, unpairedAnswer } from './offline-calls.js';
import { preflightExecutors, readRunnerExecutors } from './routing-executors.js';
import { ROUTING_LEDGER_FILE, RoutingLedger } from './routing-ledger.js';
import { ROUTING_DECISION_ENTRY, ROUTING_OPERATION, ROUTING_OUTCOME_ENTRY, routingRoleState } from './routing-setup.js';

// Tonborg's executor judgment on a runner (docs/runner.md, "Executor judgment
// on a runner"), with or without the host: the same request, instructions and
// checks as on the host (src/judgment/routing.js), over this computer's own
// executors (routing-executors.js) and its own model (routing-setup.js),
// reading what this runner keeps: the preferences the host last gave a task
// entry in the project and how this runner's earlier choices turned out. It
// only recommends; nothing is started or written to knowledge. Each decision
// and each reported outcome is kept here (routing-ledger.js) and queued in the
// outbox, which the host applies once into its Tonborg ledger.
//
// Sending: the person set this model up on this computer, which is their
// approval to send it what a judgment needs; Tonborg approves nothing itself.
// Each request carries the task as asked, the executors that passed preflight
// with their declared models, those left out and why, the cached preferences
// of the project, and the latest decisions here with their outcomes.
const FEEDBACK_LIMIT = 30;
const REQUEST_ID_MAX = 256;
const OUTCOME_GUIDANCE = 'A recommendation is not execution: start the chosen executor yourself and record what really ran. '
  + 'When it finished, report how the choice did with report_routing_outcome (decisionId, vote up or down, reason from the real run).';
// A file of the person's own that this computer cannot use: nothing is judged
// here and nothing is sent, rather than a judgment made on half a
// configuration or one quietly handed back to the host as if nothing were set
// up here. Each file's own message says what to do with it (routing-setup.js
// for model-backends.json; EXECUTORS_FIX for runner/executors.json).
const NOT_JUDGED = 'Nothing was judged here and nothing was sent to the host.';
// Deleting executors.json does not hand the judgment back: with no executor
// declared, Tonborg here answers ask_user. Only the role in model-backends.json
// decides whether this computer judges at all.
const EXECUTORS_FIX = 'Fix runner/executors.json. Deleting it does not hand this back to the host: with no executor '
  + 'declared here, Tonborg answers ask_user. To have the host judge again, remove roles.tonborg from model-backends.json '
  + 'or delete that file.';
// What one evidence item may hold: the model port refuses an item past
// MAX_EVIDENCE_CHARS (model-backends/request.js) before any model is called.
// The budget leaves room for the item's own fields (answeredAt, omitted).
const MAX_EVIDENCE_CHARS = 20_000;
const EVIDENCE_BUDGET_CHARS = 16_000;

// The items of list, in its order, whose JSON fits within maxChars together;
// one too big to fit is skipped, so it does not keep the smaller ones after it out.
function fitting(list, maxChars) {
  const kept = [];
  let size = 2;
  for (const item of list) {
    const next = size + JSON.stringify(item).length + 1;
    if (next > maxChars) continue;
    kept.push(item);
    size = next;
  }
  return kept;
}

// The preferences the host last gave this project, in the host's own compact
// receipt (judgment/preference-receipt.js), within one evidence item. A big
// project's cache does not fit whole even so: conflicts go first (no side of
// one may be applied), then the project's and Agent's own rules, then
// confirmed ones, in the order the host gave them. What does not fit is
// counted in omitted (truncated 'size_limit', not_sent), which the shared
// instructions tell the model to weigh, never left out silently.
function boundedPreferences({ answeredAt, entry }) {
  const { selected, scope_unknown: scopeUnknown, conflicts } = compactPreferences(entry);
  const rank = (rule) => (rule.scope === 'global' ? 2 : 0) + (rule.authority === 'confirmed' ? 0 : 1);
  const ordered = selected.map((rule, index) => ({ rule, index }))
    .sort((a, b) => rank(a.rule) - rank(b.rule) || a.index - b.index).map(({ rule }) => rule);
  const keptConflicts = fitting(conflicts, EVIDENCE_BUDGET_CHARS);
  const room = EVIDENCE_BUDGET_CHARS - JSON.stringify({ conflicts: keptConflicts, scope_unknown: scopeUnknown }).length;
  const keptRules = fitting(ordered, room);
  const notSent = selected.length - keptRules.length + conflicts.length - keptConflicts.length;
  return { answeredAt, status: notSent ? 'partial' : 'complete', selected: keptRules, scope_unknown: scopeUnknown,
    conflicts: keptConflicts, omitted: { truncated: notSent ? ['size_limit'] : [], ...(notSent ? { not_sent: notSent } : {}) } };
}

// The model port refuses a request whose evidence it cannot take, before any
// model is called; said here as what it is (the request, which part, nothing
// spent), never as a model answer that did not fit.
function refuseOversized(call) {
  const tooLarge = call.evidence.filter((item) => item.text.length > MAX_EVIDENCE_CHARS).map((item) => item.id);
  if (tooLarge.length) {
    throw Object.assign(new Error('The judgment request is too large for the model port'),
      { code: 'request_rejected', rejected: tooLarge });
  }
}

const outcomeSchema = z.object({ decisionId: z.string().min(1).max(256), vote: z.enum(['up', 'down']),
  reason: z.string().trim().min(1).max(1000) }).strict();

// store: the runner store (cached task entries, outbox). fetchImpl: the model
// requests' fetch, for tests.
export function createLocalRouting({ dataDir, store, fetchImpl, now = () => new Date() }) {
  const paths = resolveSetupPaths({ dataDir });
  const ledger = new RoutingLedger(join(dataDir, ROUTING_LEDGER_FILE));
  const secrets = createModelSecretStore({ path: paths.modelSecretStorePath });
  let usage = null;

  // The port for one judgment: the role as the person configured it here, its
  // data approved for this one scope, since configuring it here approved it.
  function decide(request) {
    const readConfig = () => {
      const loaded = readModelBackendConfig(paths.modelBackendConfigPath);
      if (loaded.state !== 'ok') return loaded;
      const role = loaded.config.roles.tonborg;
      const approved = { approvedProjects: [{ personalSpaceId: request.scope.personalSpaceId,
        personalProjectId: request.scope.personalProjectId }], allowUnassigned: false };
      return { ...loaded, config: { ...loaded.config, roles: { ...loaded.config.roles, tonborg: { ...role, egress: approved } } } };
    };
    usage ??= new ModelUsageLedger(paths.modelUsageLedgerPath);
    return createModelBackendPort({ readConfig, secrets, ledger: usage, ...(fetchImpl ? { fetchImpl } : {}), now })
      .decide(request);
  }

  async function assess(input, { sourceApplication, sessionId }) {
    const role = routingRoleState(dataDir);
    if (role.state === 'invalid') return failure('runner_routing_config_invalid', `${NOT_JUDGED} ${role.error}`);
    let request;
    try {
      request = parseRoutingRequest(input);
    } catch (error) {
      return failure('invalid_input', error.message);
    }
    const requestFingerprint = sha256Bytes(Buffer.from(canonicalJson(request)));
    const earlier = kept(ledger.byRequest(request), requestFingerprint);
    if (earlier) return earlier;
    const declared = readRunnerExecutors(dataDir);
    if (declared.state === 'invalid') {
      return failure('runner_routing_config_invalid', `${NOT_JUDGED} ${declared.error}. ${EXECUTORS_FIX}`);
    }
    const required = [...new Set(request.requiredCapabilities.map((value) => value.toLowerCase()))];
    const { eligible, leftOut } = preflightExecutors(declared.state === 'ok' ? declared.executors : [], required);
    let judged;
    try {
      judged = eligible.length ? await judge(request, eligible, leftOut)
        : { selected: { executorId: null, model: null, disposition: 'ask_user', conversationId: null,
          summary: 'No executor declared on this runner passes its local preflight for this task.',
          evidence: ['runner/executors.json and its local preflight'] }, modelReceipt: null };
    } catch (error) {
      return failure('judgment_failed', FAILED_JUDGMENT_GUIDANCE, { failure: judgmentFailure(error, 'decision'),
        ...(error.rejected ? { rejected: error.rejected } : {}),
        ...(error.modelReceipt ? { modelReceipt: compactReceipt(error.modelReceipt) } : {}) });
    }
    let record;
    try {
      record = decisionRecord(request, judged, eligible, leftOut);
    } catch (error) {
      // The model answered, so its budget was spent: the receipt says so even though nothing is kept.
      return failure('judgment_failed', FAILED_JUDGMENT_GUIDANCE, { failure: judgmentFailure(error, 'answer'),
        ...(judged.modelReceipt ? { modelReceipt: compactReceipt(judged.modelReceipt) } : {}) });
    }
    // What this call's model answer cost, for an answer that does not use it.
    const spent = judged.modelReceipt ? { unusedModelReceipt: compactReceipt(judged.modelReceipt) } : {};
    // The pairing again, now that the model answered: `fuli runner leave` or a
    // revoke may have come meanwhile, and nothing is kept or queued for a host
    // this computer no longer has (nor a deleted ledger made again).
    const unpaired = unpairedAnswer(store, spent);
    if (unpaired) return unpaired;
    // Another MCP process on this computer may have answered the same requestId
    // meanwhile: the decision saved first is the one kept, answered and sent,
    // and this call says its own model answer was not used.
    if (!ledger.save(record, requestFingerprint)) {
      const saved = kept(ledger.byRequest(request), requestFingerprint, spent);
      if (saved) return saved;
    }
    store.enqueue({ id: record.id, tool: ROUTING_DECISION_ENTRY, input: record, sourceApplication, sessionId });
    return answer(record);
  }

  // The decision already made for this request, or the refusal when the same
  // requestId was used for another one; null when there is none. spent: what
  // this call paid for a model answer it does not use (unusedModelReceipt).
  function kept(earlier, requestFingerprint, spent = {}) {
    if (!earlier) return null;
    return earlier.requestFingerprint === requestFingerprint ? answer(earlier.record, spent)
      : failure('invalid_input', 'requestId already belongs to a different assess_agent_action request: pass a new requestId',
        spent);
  }

  // The model's choice among the executors that passed preflight. Throws with
  // its receipt when the model did not answer (a stop is never retried here).
  async function judge(request, eligible, leftOut) {
    const scope = { personalSpaceId: request.personalSpaceId, personalProjectId: request.personalProjectId };
    const cached = projectPreferences(store, scope);
    const preferences = cached ? boundedPreferences(cached) : null;
    const recent = ledger.recent({ ...scope, limit: FEEDBACK_LIMIT }).filter((item) => item.outcome)
      .map(({ record, outcome }) => ({ id: record.id, workKind: record.workKind, objective: record.objective,
        disposition: record.disposition, selection: record.selection, summary: record.summary, outcome }));
    // Newest first, as many as fit one evidence item; the rest are counted, not dropped silently.
    const feedback = fitting(recent, EVIDENCE_BUDGET_CHARS);
    const feedbackNotSent = recent.length - feedback.length;
    // conversations: a runner reads none of the host's, so the model is shown
    // an empty list, as the host's judgment shows one when it found none.
    const data = { task: request, eligible, conversations: [], ...(leftOut.length ? { leftOut } : {}),
      ...(preferences ? { preferences } : {}), ...(feedback.length ? { feedback } : {}),
      ...(feedbackNotSent ? { feedbackNotSent } : {}) };
    const key = `runner-routing:${request.personalProjectId}:${request.requestId}`;
    const call = judgmentRequest({ operation: ROUTING_OPERATION, scope,
      requestId: key.length <= REQUEST_ID_MAX ? key : sha256Bytes(Buffer.from(key)),
      evidenceVersion: sha256Bytes(Buffer.from(canonicalJson(data))), policyVersion: 'runner',
      instructions: routingInstructions(null), schema: ROUTING_SELECTION_SCHEMA, data });
    refuseOversized(call);
    const result = await decide(call);
    if (!result.envelope) {
      throw Object.assign(new Error(`Tonborg's model on this runner did not answer (${result.modelReceipt.reason})`),
        { code: result.modelReceipt.reason, modelReceipt: result.modelReceipt });
    }
    return { selected: parseAnswer(jsonSchemaToZod(ROUTING_SELECTION_SCHEMA), result.envelope.payload),
      modelReceipt: result.modelReceipt };
  }

  // What is answered, kept and sent; throws when the choice was not one offered.
  function decisionRecord(request, { selected, modelReceipt }, eligible, leftOut) {
    const verified = verifiedSelection(selected, eligible, []);
    return { id: randomUUID(), kind: 'routing', decidedOn: 'runner', createdAt: now().toISOString(),
      personalSpaceId: request.personalSpaceId, personalProjectId: request.personalProjectId, requestId: request.requestId,
      target: request.action, agentId: request.agentId, workKind: request.workKind, objective: request.objective,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      outcome: selected.disposition === 'ask_user' ? 'escalate' : 'recommend', disposition: selected.disposition,
      conversationId: null, summary: selected.summary, evidence: selected.evidence, selection: verified.selection,
      executionRequired: verified.needsRuntime,
      ...(leftOut.length ? { leftOut } : {}),
      model: modelReceipt ? modelReceipt.actualModel ?? modelReceipt.requestedModel : null,
      ...(modelReceipt ? { judgedBy: { mode: 'model_api', independent: true }, modelReceipt: compactReceipt(modelReceipt) } : {}) };
  }

  function outcome(input, { sourceApplication, sessionId }) {
    let report;
    try {
      report = parse(outcomeSchema, input);
    } catch (error) {
      return failure('invalid_input', error.message);
    }
    const decision = ledger.get(report.decisionId);
    if (!decision) return failure('not_found', 'No executor decision with this decisionId was made on this runner in the last 30 days.');
    if (!ledger.reportOutcome(report.decisionId, report)) {
      return failure('already_reported', 'How this choice did was reported already; that report stands.');
    }
    const outboxId = randomUUID();
    store.enqueue({ id: outboxId, tool: ROUTING_OUTCOME_ENTRY, sourceApplication, sessionId,
      input: { personalSpaceId: decision.record.personalSpaceId, decisionId: report.decisionId, vote: report.vote, reason: report.reason } });
    return envelope({ status: 'queued', decisionId: report.decisionId, outboxId, runner: { decidedOn: 'runner',
      message: 'Kept on this runner as feedback for the next choice, and queued for the host\'s Tonborg ledger.' } });
  }

  function answer(record, spent = {}) {
    return envelope({ ...record, ...spent, guidance: OUTCOME_GUIDANCE, runner: { decidedOn: 'runner', delivery: 'outbox',
      message: 'Tonborg chose on this runner with its own model, among this computer\'s executors. '
        + 'The decision is queued for the host\'s Tonborg ledger and delivered when the host answers.' } });
  }

  return { assess, outcome, close: () => { ledger.close(); usage?.close(); } };
}
