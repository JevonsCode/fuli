import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { canonicalJson } from '../packages/roundtable/src/canonical-json.js';
import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { parseRoutingRequest } from '../src/judgment/routing.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { joinHost } from '../src/runner/join.js';
import { deliverOutbox } from '../src/runner/outbox-delivery.js';
import { encodeInvitation, newInvitationCode, RUNNER_PATHS } from '../src/runner/protocol.js';
import { ROUTING_LEDGER_FILE, RoutingLedger } from '../src/runner/routing-ledger.js';
import { runRunnerMcp } from '../src/runner/runner-mcp.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { createTaskPreferencePager } from '../src/graphiti/task-preference-pages.js';
import { TASK_PREFERENCE_RESULT_LIMIT_BYTES } from '../src/mcp/preference-delivery.js';
import { completePreferenceToolResult, successToolResult } from '../src/mcp/tool-result.js';
import { deliveredPreferences } from '../src/runner/local-routing.js';
import { sha256Bytes } from '../src/security/digest.js';

// Tonborg's executor judgment on a runner (docs/runner.md, "Executor judgment
// on a runner"): its own model, over its own executors, with or without the
// host; each decision and outcome reaches the host's Tonborg ledger once.
// The host is a real runner listener whose judgment service keeps an
// in-memory ledger; the runner's model is a loopback OpenAI-compatible server.
const SPACE = 'space-1';
const PROJECT = 'demo-project';
const ASK = { personalSpaceId: SPACE, personalProjectId: PROJECT, requestId: 'job-1', agentId: 'agent-1',
  workKind: 'implementation', objective: 'Change one card template', requiredCapabilities: ['coding'] };
const CHOICE = { disposition: 'delegate', conversationId: null, executorId: 'runner-node', model: 'flash-small',
  summary: 'A bounded edit: the cheap model is enough.', evidence: ['one template file'] };

test('with the host away, the runner\'s own Tonborg chooses among this computer\'s executors and queues the decision', async (t) => {
  const runner = await routingRunner(t);
  await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { projectPath: runner.projectPath, taskPrompt: 'first' } });
  runner.hostAway();

  const answer = await runner.client.callTool({ name: 'fuli_call', arguments: { toolName: 'assess_agent_action',
    input: { ...ASK, taskContextToken: 'host-token-1' } } });

  assert.equal(answer.isError, undefined, answer.content[0].text);
  const decision = answer.structuredContent;
  assert.equal(decision.decidedOn, 'runner');
  assert.deepEqual(decision.selection, { executorId: 'runner-node', model: 'flash-small', client: 'other' });
  assert.deepEqual(decision.leftOut, [{ executorId: 'nowhere', reason: 'command_not_found' }]);
  assert.equal(decision.model, 'fake-flash');
  assert.equal(runner.calls.some(({ name }) => name === 'assess_agent_action'), false, 'the host was never asked');

  const sent = JSON.stringify(runner.model.requests[0]);
  assert.match(sent, /short answers/, 'the preferences the host last gave the project went with it');
  assert.match(sent, /runner-node/);
  // Neither the token the caller passed nor the one cached with those preferences.
  assert.doesNotMatch(sent, /host-token-1/, 'no task token of the host\'s leaves the runner');
  assert.equal(runner.served.store.outbox().queued, 1);

  const again = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(again.structuredContent.id, decision.id, 'the same request gets the same decision');
  assert.equal(runner.model.requests.length, 1);
  assert.equal(runner.served.store.outbox().queued, 1);
});

test('once the host answers, the runner\'s decision and its outcome reach Tonborg\'s ledger once', async (t) => {
  const runner = await routingRunner(t);
  runner.hostAway();
  const decision = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  const report = { decisionId: decision.id, vote: 'up', reason: 'Tests passed on the first run.' };
  const reported = await runner.client.callTool({ name: 'report_routing_outcome', arguments: report });
  assert.equal(reported.structuredContent.status, 'queued');
  const twice = await runner.client.callTool({ name: 'report_routing_outcome', arguments: { ...report, vote: 'down' } });
  assert.equal(JSON.parse(twice.content[0].text).code, 'already_reported');

  runner.hostBack();
  // A delivery the runner began while the host was away may still hold the oldest entry; it waits its turn.
  for (const deadline = Date.now() + 20_000; runner.served.store.outbox().queued && Date.now() < deadline;) {
    await deliverOutbox({ store: runner.served.store, connection: runner.served.connection });
    await delay(100);
  }
  assert.deepEqual(runner.served.store.outbox(), { queued: 0, failedCount: 0, failed: [], entries: [] });

  const [record] = runner.judgment.store().records(SPACE, { personalProjectId: PROJECT });
  assert.equal(record.kind, 'routing');
  assert.equal(record.runnerDecisionId, decision.id);
  assert.equal(record.runner.name, 'Runner B');
  assert.deepEqual(record.selection, decision.selection);
  assert.equal(record.feedbackHistory.length, 1);
  assert.equal(record.feedback.vote, 'up');
  assert.match(record.feedback.reportedBy, /^runner:/);
  assert.equal(record.feedback.decidedBy, undefined, 'a runner\'s report is not the person\'s vote');

  // The workbench and an Agent both see which computer judged it.
  const [shown] = (await runner.judgment.agent.records({ personalSpaceId: SPACE, personalProjectId: PROJECT })).records;
  assert.equal(shown.decidedOn, 'runner');
  assert.equal(shown.runner.name, 'Runner B');
  assert.equal(shown.runner.fingerprint, undefined, 'the runner\'s key stays out of an Agent\'s view');

  // The same outcome delivered again (its answer was lost on the way) is applied once.
  const replayed = await runner.served.connection.postJson(RUNNER_PATHS.replay, { id: reported.structuredContent.outboxId,
    tool: 'runner_routing_outcome', input: { personalSpaceId: SPACE, ...report }, sourceApplication: 'codex', sessionId: null });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.replayedBefore, true);
  assert.equal(runner.judgment.store().records(SPACE, { personalProjectId: PROJECT })[0].feedbackHistory.length, 1);

  // The next judgment here reads how the earlier choice did.
  await runner.client.callTool({ name: 'assess_agent_action', arguments: { ...ASK, requestId: 'job-2' } });
  assert.match(JSON.stringify(runner.model.requests.at(-1)), /Tests passed on the first run/);
});

test('a runner model allowed more than executor routing is refused here; without one the host judges as before', async (t) => {
  const runner = await routingRunner(t, { operations: ['executor_routing', 'knowledge_review'] });
  const refused = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  const said = JSON.parse(refused.content[0].text);
  assert.equal(said.code, 'runner_routing_config_invalid');
  // The file was read: it says which operation is not taken, not that it could not be read.
  assert.match(said.message, /knowledge_review/);
  assert.doesNotMatch(said.message, /could not be read/);
  assert.equal(runner.model.requests.length, 0);
  assert.equal(runner.calls.length, 0);

  rmSync(path.join(runner.dataDir, 'model-backends.json'));
  const listed = await runner.client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === 'report_routing_outcome'), false);
  await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.deepEqual(runner.calls.map(({ name }) => name), ['assess_agent_action']);
});

test('with the host answering, a runner that judges here never asks it', async (t) => {
  const runner = await routingRunner(t);
  const answer = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(answer.structuredContent.decidedOn, 'runner');
  assert.equal(runner.calls.some(({ name }) => name === 'assess_agent_action'), false, 'the host was never asked');
});

test('once the pairing is gone or revoked, nothing is judged here and no model is called', async (t) => {
  const revoked = await routingRunner(t);
  revoked.served.store.revoked();
  const refused = await revoked.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(JSON.parse(refused.content[0].text).code, 'runner_revoked');
  assert.equal(revoked.model.requests.length, 0, 'no model budget was spent');
  assert.equal(revoked.served.store.outbox().queued, 0, 'nothing was queued for a host that will not take it');
  const report = { decisionId: 'any-decision', vote: 'up', reason: 'It ran.' };
  const noReport = await revoked.client.callTool({ name: 'report_routing_outcome', arguments: report });
  assert.equal(JSON.parse(noReport.content[0].text).code, 'runner_revoked', 'no outcome is reported for a host that revoked it');

  // `fuli runner leave` while a client's MCP process still runs: the pairing is gone, but on
  // Windows the open store cannot be deleted, so it stays, emptied (runner-command.js leaveHost).
  const left = await routingRunner(t);
  left.served.store.leave();
  const unpaired = await left.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(JSON.parse(unpaired.content[0].text).code, 'runner_not_paired');
  assert.equal(left.model.requests.length, 0);
  assert.equal(existsSync(path.join(left.dataDir, ROUTING_LEDGER_FILE)), false, 'no decision ledger was made');
  const notReported = await left.client.callTool({ name: 'report_routing_outcome', arguments: report });
  assert.equal(JSON.parse(notReported.content[0].text).code, 'runner_not_paired');
});

test('a leave or revoke that comes while the model answers keeps nothing, and says what the model cost', async (t) => {
  let runner;
  // The pairing ends between the check before the model and its answer.
  runner = await routingRunner(t, { reply: () => { runner.served.store.leave(); return null; } });
  const answer = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  const body = JSON.parse(answer.content[0].text);
  assert.equal(body.code, 'runner_not_paired');
  assert.equal(body.unusedModelReceipt.status, 'completed', 'the model was paid for and its answer not used');
  assert.equal(existsSync(path.join(runner.dataDir, ROUTING_LEDGER_FILE)), false, 'no decision was kept');
});

test('a runner store `fuli runner leave` deleted is not made again by queueing into it', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-left-')));
  const file = path.join(dir, RUNNER_FILE);
  const store = new RunnerStore(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.throws(() => store.enqueue({ id: 'entry-1', tool: 'runner_routing_decision', input: {}, sourceApplication: 'codex' }),
    /no longer paired/);
  assert.equal(existsSync(file), false);
});

test('`fuli runner leave` deletes the decisions made here and says what the person\'s own files leave behind', async (t) => {
  const runner = await routingRunner(t);
  await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  const ledgerFile = path.join(runner.dataDir, 'runner', 'routing.sqlite');
  assert.equal(existsSync(ledgerFile), true);
  await runner.served.close();

  const lines = [];
  const result = await runRunnerCommand(['leave', '--force', '--data-dir', runner.dataDir], { write: (line) => lines.push(line) });
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(ledgerFile), false, 'the decisions made here are deleted');
  assert.equal(existsSync(path.join(runner.dataDir, RUNNER_FILE)), false);
  const said = lines.join('\n');
  assert.match(said, /model-backends\.json/);
  assert.match(said, /executors\.json/);
});

test('`fuli runner leave` says which file it could not delete instead of saying all is deleted', async (t) => {
  const runner = await routingRunner(t);
  await runner.served.close();
  // A path that cannot be deleted or opened as a ledger, as an open file on Windows cannot be deleted.
  const ledgerFile = path.join(runner.dataDir, ROUTING_LEDGER_FILE);
  mkdirSync(ledgerFile, { recursive: true });
  writeFileSync(path.join(ledgerFile, 'held'), '');

  const lines = [];
  await runRunnerCommand(['leave', '--force', '--data-dir', runner.dataDir], { write: (line) => lines.push(line) });
  const said = lines.join('\n');
  assert.doesNotMatch(said, /are deleted\./, 'it does not say everything was deleted');
  assert.match(said, /could not be deleted/);
  assert.match(said, /runner\/routing\.sqlite: still holds the executor decisions made here/);
  assert.equal(existsSync(path.join(runner.dataDir, RUNNER_FILE)), false, 'the other file was still deleted');
});

test('a model-backends.json that cannot be read says so, and names the file and the way back', async (t) => {
  const runner = await routingRunner(t, { backends: '{ not json' });
  const refused = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  const { code, message } = JSON.parse(refused.content[0].text);
  assert.equal(code, 'runner_routing_config_invalid');
  assert.match(message, /model-backends\.json/);
  assert.match(message, /nothing was judged/i);
  assert.match(message, /delete it to have the host judge this again/, 'deleting this file is what hands it back');
  assert.equal(runner.calls.length, 0, 'a broken file here is not quietly sent to the host');
});

test('runner/executors.json missing or unreadable is told apart, and neither calls the model', async (t) => {
  const none = await routingRunner(t, { executors: null });
  const asked = await none.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(asked.isError, undefined, asked.content[0].text);
  assert.equal(asked.structuredContent.disposition, 'ask_user');
  assert.equal(none.model.requests.length, 0, 'with no executor declared the model is never asked');

  const broken = await routingRunner(t, { executors: '{"version": 1, "executors": [{ "executorId": "" }]}' });
  const refused = await broken.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  const { code, message } = JSON.parse(refused.content[0].text);
  assert.equal(code, 'runner_routing_config_invalid');
  assert.match(message, /executors\.json/);
  // Deleting it leaves no executor here (the ask_user above), so that is not offered as the way back.
  assert.match(message, /Deleting it does not hand this back to the host/);
  assert.match(message, /model-backends\.json/, 'it names the file that does');
  assert.equal(broken.model.requests.length, 0);
});

test('a model that refuses or runs out of budget fails the judgment with its receipt', async (t) => {
  const runner = await routingRunner(t, { reply: () => ({ status: 429, body: { error: { message: 'rate limited' } } }) });
  const failed = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  const body = JSON.parse(failed.content[0].text);
  assert.equal(body.code, 'judgment_failed');
  assert.equal(body.modelReceipt.status, 'failed');
  assert.equal(runner.served.store.outbox().queued, 0);
});

test('nothing here offers a conversation to reuse, and a choice that is not offered says the model was paid', async (t) => {
  const reuse = { ...CHOICE, disposition: 'reuse_conversation', conversationId: 'conversation-1' };
  const runner = await routingRunner(t, { reply: () => ({ status: 200, body: { model: 'fake-flash', choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify({ decision: 'propose', payload: reuse, reason: 'r', evidenceIds: ['eligible'], uncertainty: null }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } } }) });
  const failed = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  const body = JSON.parse(failed.content[0].text);
  assert.equal(body.code, 'judgment_failed');
  assert.equal(body.modelReceipt.status, 'completed', 'the model answered, so its receipt says the budget was spent');
  assert.match(runner.model.requests[0].messages.at(-1).content, /\{"id":"conversations","text":"\[\]"\}/,
    'the model is told there is no conversation here to reuse');
});

test('two processes answering one requestId at once keep one decision instead of failing', async (t) => {
  const runner = await routingRunner(t);
  const first = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  // What a second MCP process does when it got past the lookup before the first saved: the same insert.
  const ledger = new RoutingLedger(path.join(runner.dataDir, ROUTING_LEDGER_FILE));
  try {
    const clash = { ...first, id: 'another-process-decision' };
    assert.doesNotThrow(() => ledger.save(clash, 'another-fingerprint'));
    assert.equal(ledger.byRequest(ASK).record.id, first.id, 'the decision saved first is the one kept');
  } finally {
    // Before the runner's folder is deleted: Windows refuses to delete a SQLite file still open.
    ledger.close();
  }
});

test('a process that loses the requestId race answers with the decision kept first, and says its model answer was not used', async (t) => {
  let runner;
  const winner = { id: 'decision-of-another-process', kind: 'routing', decidedOn: 'runner', createdAt: new Date().toISOString(),
    personalSpaceId: SPACE, personalProjectId: PROJECT, requestId: ASK.requestId, disposition: 'ask_user', selection: null };
  // While this process's model answers, another process of this computer saves its decision for the same request.
  runner = await routingRunner(t, { reply: () => {
    const other = new RoutingLedger(path.join(runner.dataDir, ROUTING_LEDGER_FILE));
    try {
      other.save(winner, sha256Bytes(Buffer.from(canonicalJson(parseRoutingRequest(ASK)))));
    } finally {
      other.close();
    }
    return null;
  } });

  const answer = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(answer.isError, undefined, answer.content[0].text);
  assert.equal(answer.structuredContent.id, winner.id, 'the decision saved first is the answer');
  assert.equal(answer.structuredContent.unusedModelReceipt.status, 'completed', 'this call\'s own model cost is said');
  assert.equal(runner.served.store.outbox().queued, 0, 'the other process queues its decision; this one queues nothing');
});

test('a decision naming a project the host does not have is refused there, with the reason on the runner', async (t) => {
  const runner = await routingRunner(t, { projects: [] });
  await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  let outbox = runner.served.store.outbox();
  for (const deadline = Date.now() + 20_000; outbox.queued && Date.now() < deadline;) {
    outbox = await deliverOutbox({ store: runner.served.store, connection: runner.served.connection });
    await delay(50);
  }
  outbox = runner.served.store.outbox();
  assert.equal(outbox.queued, 0, 'a refusal it cannot outlive is not retried for ever');
  assert.equal(outbox.failed.length, 1);
  assert.match(outbox.failed[0].reason, /project/);
  assert.equal(runner.judgment.store().records(SPACE, { personalProjectId: PROJECT }).length, 0);
});

test('a runner\'s reported outcome is kept, but the person\'s own vote stays this record\'s feedback', async (t) => {
  const runner = await routingRunner(t);
  runner.hostAway();
  const decision = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  runner.hostBack();
  for (const deadline = Date.now() + 20_000; runner.served.store.outbox().queued && Date.now() < deadline;) {
    await deliverOutbox({ store: runner.served.store, connection: runner.served.connection });
    await delay(50);
  }
  const [saved] = runner.judgment.store().records(SPACE, { personalProjectId: PROJECT });
  await runner.judgment.feedback({ personalSpaceId: SPACE, decisionId: saved.id, vote: 'down',
    reason: 'It picked the wrong one.', expectedRevision: saved.feedback.revision });

  const reported = await runner.client.callTool({ name: 'report_routing_outcome',
    arguments: { decisionId: decision.id, vote: 'up', reason: 'Tests passed on the first run.' } });
  assert.equal(reported.structuredContent.status, 'queued');
  for (const deadline = Date.now() + 20_000; runner.served.store.outbox().queued && Date.now() < deadline;) {
    await deliverOutbox({ store: runner.served.store, connection: runner.served.connection });
    await delay(50);
  }

  const record = runner.judgment.store().get(SPACE, saved.id);
  assert.equal(record.feedbackHistory.length, 2, 'the machine\'s report is kept');
  assert.equal(record.feedbackHistory.at(-1).reportedBy.startsWith('runner:'), true);
  assert.equal(record.feedback.vote, 'down', 'the person\'s vote still stands');
  assert.equal(record.feedback.reason, 'It picked the wrong one.');
  assert.equal(record.feedback.revision, 2, 'the next vote still writes on top of the whole history');

  // Searching finds the record by the person's words, not by the report that did not replace them.
  const search = (text) => runner.judgment.records({ personalSpaceId: SPACE, personalProjectId: PROJECT, search: text });
  assert.equal((await search('wrong one')).records.length, 1);
  assert.equal((await search('first run')).records.length, 0);

  // An Agent sees which feedback is a runner's report, without the runner's key.
  const [shown] = (await runner.judgment.agent.records({ personalSpaceId: SPACE, personalProjectId: PROJECT })).records;
  assert.equal(shown.feedbackHistory.at(-1).reportedBy, 'runner');
  assert.equal(shown.feedbackHistory[0].reportedBy, undefined, 'the person\'s vote is not marked as a report');
  assert.doesNotMatch(JSON.stringify(shown.feedbackHistory), /runner:/);
});

test('the runner lists assess_agent_action as it behaves here, beside its outcome tool', async (t) => {
  const runner = await routingRunner(t);
  const listed = await runner.client.listTools();
  const assess = listed.tools.find((tool) => tool.name === 'assess_agent_action');
  assert.match(assess.description, /runner/i);
  assert.doesNotMatch(assess.description, /registered|authorized|preflighted|verified conversation/i);
  assert.equal(listed.tools.filter((tool) => tool.name === 'report_routing_outcome').length, 1);
});

// A paired runner whose model-backends.json lets its Tonborg choose executors
// (operations) and whose executors.json declares one executor it can start and one it cannot.
// backends/executors: what those two files hold instead; reply: the model's answer.
// projects: the projects the host knows, for the scope check a decision passes there.
// A project's preferences at a real one's size: count rules whose text runs
// from 80 to 450 characters (about 200 on average), each with the reasoning
// and attributes a task entry carries beside it; every fifth is inherited from
// a parent project. Made-up words throughout.
function realisticPreferences(count, { longest = 450, chinese = false } = {}) {
  const words = chinese ? '改动要小，说清检查了什么，任何东西离开这台电脑之前先问一声。'
    : 'keep the change small, say what was checked, and ask before anything leaves this computer. ';
  return Array.from({ length: count }, (_, index) => {
    const chars = 80 + Math.round(((index * 37) % 100) / 99 * (longest - 80));
    return { preference_key: `habit-${index}`, preference_scope: index % 3 ? 'global' : 'project',
      instruction: `Rule ${index}: ${words.repeat(Math.ceil(chars / words.length))}`.slice(0, chars),
      title: `Habit ${index}`, confirmation_status: index % 4 ? 'confirmed' : 'ai_confirmed', weight: 0.8,
      ...(index % 5 === 0 ? { inherited_from_project_id: 'parent-project-of-the-example', scope_distance: 1 } : {}),
      reason: `Why habit ${index} holds: ${'the person asked for it after a long review. '.repeat(4)}`,
      reasoning_summary: `Habit ${index} came from ${'several sessions where it mattered to the result. '.repeat(4)}`,
      attributes: { source: 'example', note: 'x'.repeat(40) } };
  });
}

const CONFLICTS = [1, 2, 3].map((index) => ({ preference_key: `split-${index}`, preference_scope: 'project',
  alternatives: [{ instruction: `Do ${index} one way.`, confirmation_status: 'confirmed' },
    { instruction: `Do ${index} the other way.`, confirmation_status: 'confirmed' }] }));

// Every rule key and conflict key in the preference evidence the model was sent, across its parts.
function sentPreferenceKeys(request) {
  const text = request.messages.at(-1).content;
  const evidence = JSON.parse(text.slice(text.indexOf('DATA: ') + 6)).evidence;
  const parts = evidence.filter((item) => item.id === 'preferences' || item.id.startsWith('preferences_'));
  for (const item of evidence) assert.ok(item.text.length <= 20_000, `${item.id} fits the model port`);
  const values = parts.map((item) => JSON.parse(item.text));
  return { parts: parts.map((item) => item.id), rules: values.flatMap((value) => (value.selected ?? []).map((rule) => rule.key)),
    conflicts: values.flatMap((value) => (value.conflicts ?? []).map((conflict) => conflict.key)), values };
}

test('a project with as many preferences as a real one is judged with every rule, in parts the model port takes', async (t) => {
  const preferences = realisticPreferences(75);
  const lengths = preferences.map((rule) => rule.instruction.length);
  const average = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  assert.ok(Math.min(...lengths) >= 80 && Math.max(...lengths) >= 440 && average > 180 && average < 280, `average ${average}`);
  const runner = await routingRunner(t, { preferences, conflicts: CONFLICTS });

  const answer = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(answer.isError, undefined, answer.content[0].text);
  assert.deepEqual(answer.structuredContent.selection, { executorId: 'runner-node', model: 'flash-small', client: 'other' });
  assert.equal(runner.model.requests.length, 1, 'the model was called');
  const sent = sentPreferenceKeys(runner.model.requests[0]);
  assert.ok(sent.parts.length > 1, 'more than one evidence item holds them');
  assert.deepEqual(sent.rules, preferences.map((rule) => rule.preference_key), 'every rule went, in the host\'s order');
  assert.deepEqual(sent.conflicts, CONFLICTS.map((conflict) => conflict.preference_key), 'every conflict went');
  assert.equal(sent.values[0].status, 'complete');
  assert.ok(sent.values.slice(1).every((value) => value.continues === 'preferences'));
  const text = runner.model.requests[0].messages.at(-1).content;
  assert.match(text, /parent-project-of-the-example/, 'where an inherited rule comes from goes with it');
  assert.doesNotMatch(text, /several sessions where it mattered/, 'reasoning stays in FULI, as on the host');
});

test('a task entry over the host\'s delivery limit is read whole with the host\'s reader, and judged with every rule', async (t) => {
  // As a real project's are: the entry is over 32 KB, so the host delivers it blocked, with none of the rules.
  const preferences = realisticPreferences(75, { chinese: true });
  const runner = await routingRunner(t, { preferences, conflicts: CONFLICTS, delivery: 'real', entered: false });
  const entry = (await runner.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: runner.projectPath, taskPrompt: 'first' } })).structuredContent;
  assert.equal(entry.preference_delivery.status, 'blocked', 'the host could not deliver it whole');
  assert.equal(entry.preferences_complete, false);

  const answer = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(answer.isError, undefined, answer.content[0].text);
  assert.equal(answer.structuredContent.selection.executorId, 'runner-node');
  const reads = runner.calls.filter(({ input }) => input?.toolName === 'read_task_preferences');
  assert.ok(reads.length > 1, 'the rest was read page by page');
  assert.ok(reads.every(({ input }) => input.input.taskContextToken === 'host-token-1'), 'with the entry\'s own token');
  const sent = sentPreferenceKeys(runner.model.requests[0]);
  assert.deepEqual(sent.rules, preferences.map((rule) => rule.preference_key), 'every rule, none missing');
  assert.deepEqual(sent.conflicts, CONFLICTS.map((conflict) => conflict.preference_key));
  assert.match(runner.model.requests[0].messages.at(-1).content, /preferences_2, preferences_3 and so on continue preferences/,
    'the model is told the later parts apply as the first');
});

test('a task entry the host could not deliver whole, whose rest was not read, stops the judgment', async (t) => {
  // The host delivers the entry blocked and does not serve its reader here.
  const runner = await routingRunner(t, { preferences: realisticPreferences(75, { chinese: true }), delivery: 'blocked' });
  const decision = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  assert.equal(decision.disposition, 'ask_user', 'not judged with part of the rules, or none');
  assert.deepEqual(decision.evidence, ['preference_delivery:partial']);
  assert.match(decision.summary, /could not deliver this project's preferences whole/);
  assert.equal(runner.model.requests.length, 0);
});

test('one rule longer than a part is named, and a part of exactly the limit still goes', () => {
  const rule = (instruction) => ({ preference_key: 'habit-long', preference_scope: 'global', instruction, confirmation_status: 'confirmed' });
  const deliver = (instruction) => deliveredPreferences({ answeredAt: '2026-01-01T00:00:00.000Z', context: {},
    entry: { effective_preferences: [rule(instruction)] } });
  const base = JSON.stringify(deliver('').parts.preferences).length;
  const exact = deliver('x'.repeat(20_000 - base));
  assert.equal(JSON.stringify(exact.parts.preferences).length, 20_000, 'a part of exactly 20,000 characters');
  assert.equal(exact.receipt.status, 'complete');
  // One more character and the first part is over: the rule goes on in a part of its own, still whole.
  const next = deliver('x'.repeat(20_001 - base));
  assert.equal(next.receipt.status, 'complete');
  assert.equal(next.parts.preferences_2.selected[0].key, 'habit-long');
  assert.ok(JSON.stringify(next.parts.preferences_2).length <= 20_000);
  // A rule no part can hold is named.
  const over = deliver('x'.repeat(20_000));
  assert.deepEqual(over.parts, {});
  assert.equal(over.tooLarge, 'habit-long', 'the rule that does not fit is named');
  assert.deepEqual(over.receipt.omitted.truncated, ['size_limit']);
});

test('the rule too long for any part is named in what the person reads', async (t) => {
  const preferences = [{ preference_key: 'habit-very-long', preference_scope: 'project', confirmation_status: 'confirmed',
    instruction: 'a'.repeat(21_000) }];
  const runner = await routingRunner(t, { preferences });
  const decision = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  assert.equal(decision.disposition, 'ask_user');
  assert.match(decision.summary, /Preference habit-very-long alone is longer than one part/);
  assert.equal(runner.model.requests.length, 0);
});

test('rules too many even in parts stop the judgment here, as on the host, with no model call', async (t) => {
  // Far past what four evidence items hold even compact.
  const runner = await routingRunner(t, { preferences: realisticPreferences(800, { longest: 450 }) });
  const answer = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(answer.isError, undefined, answer.content[0].text);
  const decision = answer.structuredContent;
  assert.equal(decision.disposition, 'ask_user', 'Tonborg does not recommend while a rule may be missing');
  assert.equal(decision.selection, null);
  assert.deepEqual(decision.evidence, ['preference_delivery:partial'], 'the host\'s own hold, not one of the runner\'s');
  assert.match(decision.summary, /remove roles\.tonborg from model-backends\.json/, 'it says what the person can do');
  assert.equal(decision.modelReceipt, undefined, 'nothing was spent');
  assert.equal(runner.model.requests.length, 0, 'no model was called');
});

test('with no preferences of the host\'s kept for the project, nothing is judged here, as on the host', async (t) => {
  const runner = await routingRunner(t, { entered: false });
  const decision = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  assert.equal(decision.disposition, 'ask_user');
  assert.deepEqual(decision.evidence, ['preference_delivery:unavailable']);
  assert.match(decision.summary, /Enter one \(get_collaboration_preferences/, 'it says how to keep them');
  assert.match(decision.summary, /remove roles\.tonborg/);
  assert.equal(runner.model.requests.length, 0);
});

test('preferences the host itself could not read in full stop the judgment here too', async (t) => {
  const runner = await routingRunner(t, { hostContext: { source_truncated: true,
    source_windows: { candidates_truncated: true, project_ancestors_truncated: false, queued_conflicts_truncated: false } } });
  const decision = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  assert.equal(decision.disposition, 'ask_user');
  assert.deepEqual(decision.evidence, ['preference_delivery:partial']);
  assert.match(decision.summary, /candidates truncated/, 'the host\'s own reason, from the kept entry\'s flags');
  assert.equal(runner.model.requests.length, 0);
});

test('a request too large to send is refused here as what it is, and no model is called', async (t) => {
  // Two executors at their declared limits: more than one evidence item holds.
  const models = Array.from({ length: 32 }, (_, index) => ({ model: `model-${index}`, note: 'n'.repeat(500) }));
  const executors = JSON.stringify({ version: 1, executors: ['first', 'second'].map((name) => ({
    executorId: `runner-${name}`, displayName: name, client: 'other', command: 'node', capabilities: ['coding'], models })) });
  const runner = await routingRunner(t, { executors });

  const failed = JSON.parse((await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).content[0].text);
  assert.equal(failed.code, 'judgment_failed');
  assert.equal(failed.failure.category, 'request_rejected', 'not taken for a model answer that did not fit');
  assert.deepEqual(failed.rejected, ['eligible']);
  assert.equal(failed.modelReceipt, undefined);
  assert.equal(runner.model.requests.length, 0, 'no model was called, so nothing was spent');
});

// preferences, conflicts: what the host's task entry gives the project, as a task entry answers them;
// hostContext: more of that entry's context (what the host's read did not read in full).
// entered: a task in the project was entered here while the host answered, as a client's hook does,
// so this runner keeps the host's preferences for it (calls starts empty after it).
async function routingRunner(t, { operations = ['executor_routing'], backends, executors, reply,
  projects = [{ projectId: PROJECT, profile: { lifecycle: 'active' } }], preferences = [{ preference_key: 'answer-length',
    preference_scope: 'global', instruction: 'short answers', confirmation_status: 'confirmed' }], conflicts = [],
  hostContext = {}, entered = true, delivery = 'raw' } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-routing-')));
  const model = await fakeModel(reply);
  const host = deviceIdentity(await createDeviceCertificate());
  const store = new RunnerHostStore(':memory:');
  const calls = [];
  const pager = createTaskPreferencePager();
  const judgment = createJudgmentService({ app: { config: { personal: { spaceId: SPACE } },
    listPersonalProjects: async () => projects }, openStore: () => new JudgmentStore() });
  const routes = createRunnerRoutes({ app: { judgment }, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(),
    createMcp: () => {
      const server = new Server({ name: 'fuli', version: 'test' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['get_collaboration_preferences', 'assess_agent_action']
        .map((name) => ({ name, inputSchema: { type: 'object' } })) }));
      server.setRequestHandler(CallToolRequestSchema, (request) => {
        calls.push({ name: request.params.name, input: request.params.arguments });
        const entry = { effective_preferences: preferences, taskContextToken: 'host-token-1', task_context_token: 'host-token-1',
          checkpoint_required: true, agent_receipt: { markdown: 'receipt' }, active_conflicts: conflicts,
          context: { personal_space_id: SPACE, personal_project_id: PROJECT, ...hostContext } };
        const named = request.params.name === 'fuli_call' ? request.params.arguments?.toolName : request.params.name;
        if (named === 'get_collaboration_preferences') {
          // As the host delivers a task entry (create-mcp-server.js): through its 32 KB limit, when delivery is real.
          return delivery === 'raw' ? { content: [{ type: 'text', text: JSON.stringify(entry) }], structuredContent: entry }
            : successToolResult(entry, { limitBytes: TASK_PREFERENCE_RESULT_LIMIT_BYTES, itemLimit: 1000, preferenceContext: true });
        }
        if (named === 'read_task_preferences') {
          if (delivery !== 'real') return { isError: true, content: [{ type: 'text', text: '{"code":"preferences_blocked"}' }] };
          // The host's own pager over the whole set, page by page as read_task_preferences serves it.
          return completePreferenceToolResult(pager.read({ ...entry, deferred_conflicts: [], preferences_complete: true,
            preference_delivery: { status: 'complete' } }, { cursor: request.params.arguments?.input?.cursor }));
        }
        const value = { outcome: 'recommend', decidedOn: 'host' };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      });
      return server;
    } });
  const state = { away: false };
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      if (!state.away) return routes.handle(request, response, context);
      request.socket.destroy();
      return true;
    } });
  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const dataDir = path.join(base, 'runner-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port: listener.port,
    certPem: host.certPem, code }) });
  writeFileSync(path.join(dataDir, 'model-backends.json'), backends ?? JSON.stringify({ version: 1,
    connections: { flash: { protocol: 'openai_chat', endpoint: `${model.origin}/v1`, model: 'fake-flash' } },
    roles: { tonborg: { enabled: true, connection: 'flash', allowedOperations: operations, budget: {} } } }));
  if (executors !== null) {
    writeFileSync(path.join(dataDir, 'runner', 'executors.json'), executors ?? JSON.stringify({ version: 1, executors: [
      { executorId: 'runner-node', displayName: 'Node here', client: 'other', command: 'node', capabilities: ['coding'],
        models: [{ model: 'flash-small', costRank: 1 }, { model: 'deep-large', costRank: 5 }] },
      { executorId: 'nowhere', displayName: 'Not installed', client: 'other', command: 'fuli-test-no-such-command',
        capabilities: ['coding'], models: [{ model: 'any' }] }] }));
  }
  const projectPath = path.join(base, 'demo-project');
  mkdirSync(projectPath);

  const client = new Client({ name: 'codex', version: 'test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runRunnerMcp({ dataDir, sourceApplication: 'codex', transport: serverSide,
    lookUp: async () => [], retryAfterMs: 0 });
  await client.connect(clientSide);
  if (entered) {
    await client.callTool({ name: 'get_collaboration_preferences', arguments: { projectPath, taskPrompt: 'first' } });
    calls.length = 0;
  }
  // In this order, the folder last: Windows refuses to delete a SQLite file that is still open.
  t.after(async () => {
    await client.close();
    await served.close();
    await listener.close();
    await routes.close();
    store.close();
    judgment.close();
    await model.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { client, served, calls, model, judgment, dataDir, projectPath,
    hostAway: () => { state.away = true; }, hostBack: () => { state.away = false; } };
}

// An OpenAI-compatible endpoint on loopback that always makes CHOICE, keeping
// each request it got. reply(count): another { status, body } for the answer.
async function fakeModel(reply = null) {
  const requests = [];
  const server = createServer((request, response) => {
    // FULI asks a loopback model for its Ollama build; this one is none.
    if (request.method !== 'POST') return void response.writeHead(404).end();
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      const answer = reply?.(requests.length);
      if (answer) {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        return void response.end(JSON.stringify(answer.body));
      }
      const content = JSON.stringify({ decision: 'propose', payload: CHOICE, reason: 'bounded edit', evidenceIds: ['eligible'],
        uncertainty: null });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'fake-flash', choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 900, completion_tokens: 60 } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
