// The rec#15 PR4 gates (D-29.5, D-29.10, D-29.11) on acceptance/context-delivery-replay:
// every scenario through the real hook entries, with the tiny and the scaled
// synthetic fixture. Synthetic transcripts and Provider only; bytes, no tokens.
import assert from 'node:assert/strict';
import test from 'node:test';
import { measure } from '../acceptance/context-delivery-replay/run.js';
import { markdownTable } from '../acceptance/context-delivery-replay/report.js';
import { FIXTURES } from '../acceptance/context-delivery-replay/fixtures.js';
import { PROVIDER_RECOVERY_WINDOW, syntheticJournal } from '../test-support/synthetic-context-session.js';

// The exact encoding a complete frame with preferences adds (D-29.10): its
// 12-hex revision field. The per-turn allowance is this measured byte count.
const REVISION_FIELD_BYTES = Buffer.byteLength(',"revision":"0123456789ab"', 'utf8');
// A turn that carries a recovery.withdrawn block may exceed by this much more (D-29.5).
const WITHDRAWN_ALLOWANCE_BYTES = 128;
// D-29.5 (and the unchanged-preferences scenario): strictly below the uncached baseline with the scaled fixture.
const STRICTLY_SMALLER = ['acceptance', 'edit_withdraw', 'scene_switch', 'compact_resume', 'delivery_failure', 'unchanged'];

const result = measure();
const variants = async () => (await result).variants;
const describe = (variant, scenario, turn, index) => `${variant} ${scenario} turn ${index + 1} (${turn.session} ${turn.note}): `
  + `${turn.preference_delivery}, ${turn.preferences_sent} preferences, ${turn.messages_sent} messages, `
  + `produced ${turn.produced_bytes} B, no cache ${turn.no_cache_bytes} B, revision field ${turn.revision_field_bytes} B`;

function allowance(turn) {
  const full = turn.preference_delivery === 'full' && turn.preferences_sent > 0 ? turn.revision_field_bytes : 0;
  return full + (turn.withdrawn_sequences.length ? WITHDRAWN_ALLOWANCE_BYTES : 0);
}

test('the replay measures both fixtures in bytes with fixed synthetic sizes', async () => {
  const measured = await result;
  assert.match(measured.unit, /UTF-8 bytes.*No token estimates/);
  assert.deepEqual(measured.variants.map(item => item.variant), ['tiny', 'scaled']);
  const scaled = FIXTURES.scaled;
  const preferences = [...scaled.boundary, ...scaled.general, ...scaled.spacing, ...scaled.palette, ...scaled.radius,
    ...scaled.editedSpacing.slice(0, 1)];
  for (const item of preferences) {
    const size = Buffer.byteLength(item.instruction, 'utf8');
    assert.ok(size >= 120 && size <= 400, `${item.preference_key} is ${size} B`);
  }
  for (const [group, messages] of Object.entries(scaled.messages)) {
    for (const [, text] of messages) {
      const size = Buffer.byteLength(text, 'utf8');
      assert.ok(size >= 120 && size <= 1500, `${group} message is ${size} B`);
      assert.match(text, /```/);
      assert.match(text, /[一-鿿]/);
    }
  }
  assert.match(markdownTable(measured.variants), /\*\*tiny\*\*[\s\S]*\| acceptance \| 8 \|[\s\S]*\*\*scaled\*\*/);
  assert.match(markdownTable(measured.variants), /skeleton \(diagnostic\)/);
});

test('every delivered turn keeps the model view whole and every scenario check passes', async () => {
  for (const { variant, scenarios } of await variants()) {
    for (const scenario of scenarios) {
      assert.deepEqual(scenario.checks.filter(check => !check.pass), [], `${variant} ${scenario.scenario}`);
      const wrong = scenario.detail.map((turn, index) => [turn, index]).filter(([turn]) => turn.correctness && !turn.correctness.ok)
        .map(([turn, index]) => `${describe(variant, scenario.scenario, turn, index)}: ${JSON.stringify(turn.correctness)}`);
      assert.deepEqual(wrong, []);
      assert.deepEqual(scenario.correctness.withdrawn_present, []);
    }
  }
});

test('a complete frame adds exactly its 12-hex revision field and no turn costs more than the uncached entry otherwise', async () => {
  assert.equal(REVISION_FIELD_BYTES, 26);
  const failures = [];
  for (const { variant, scenarios } of await variants()) {
    for (const scenario of scenarios) {
      scenario.detail.forEach((turn, index) => {
        if (![0, REVISION_FIELD_BYTES].includes(turn.revision_field_bytes)) failures.push(`${describe(variant, scenario.scenario, turn, index)}: revision encoding`);
        if (turn.produced_bytes - turn.no_cache_bytes > allowance(turn)) {
          failures.push(`${describe(variant, scenario.scenario, turn, index)}: over by ${turn.produced_bytes - turn.no_cache_bytes - allowance(turn)} B`);
        }
      });
    }
  }
  assert.deepEqual(failures, []);
});

test('no scenario costs more than the uncached baseline, and the scaled ones that reuse context cost less', async () => {
  const failures = [];
  for (const { variant, scenarios } of await variants()) {
    for (const scenario of scenarios) {
      const strict = variant === 'scaled' && STRICTLY_SMALLER.includes(scenario.scenario);
      if (strict ? scenario.produced_bytes >= scenario.no_cache_bytes : scenario.produced_bytes > scenario.no_cache_bytes) {
        failures.push(`${variant} ${scenario.scenario}: produced ${scenario.produced_bytes} B, no cache ${scenario.no_cache_bytes} B`);
      }
      assert.ok(scenario.host_visible_bytes <= scenario.produced_bytes);
    }
  }
  assert.deepEqual(failures, []);
});

test('Codex hook frames are confirmed: after a scene switch a delta follows and the steady state resends nothing seen', async () => {
  for (const { variant, scenarios } of await variants()) {
    const turns = scenarios.find(item => item.scenario === 'scene_switch').detail.filter(turn => turn.client === 'codex');
    assert.deepEqual(turns.map(turn => turn.note), ['frontend', 'chat', 'frontend again', 'frontend, same scene']);
    assert.ok(turns.slice(2).some(turn => turn.preference_delivery === 'delta'), `${variant}: ${turns.map(turn => turn.preference_delivery)}`);
    assert.equal(turns.at(-1).preference_delivery, 'delta');
    assert.equal(turns.at(-1).resent_seen_items, 0, variant);
    const added = scenarios.find(item => item.scenario === 'add_fourth').detail.filter(turn => turn.client === 'codex').at(-1);
    assert.equal(added.preference_delivery, 'delta', variant);
  }
});

test('the acceptance scenario keeps its pointer bound and its retrieval counted', async () => {
  for (const { scenarios } of await variants()) {
    const [acceptance] = scenarios;
    assert.equal(acceptance.turns, 8);
    assert.equal(acceptance.buckets.first_or_reset_full.turns, 2, 'C and H each start once');
    assert.equal(acceptance.host_visible_bytes, acceptance.produced_bytes, 'every acceptance frame is recorded in full');
    assert.equal(acceptance.pointer_bytes.length, 1);
    assert.ok(acceptance.pointer_bytes[0] <= 320);
    assert.ok(acceptance.retrieval_calls.total > 0);
  }
});

// dot rec#10 6365998098 item 2: every reread the delivery rules require is counted.
test('no delivered turn leaves the model without a base it can locate by the rules', async () => {
  const rereads = [];
  for (const { variant, scenarios } of await variants()) {
    for (const scenario of scenarios) {
      scenario.detail.forEach((turn, index) => {
        if (turn.rereads_required) rereads.push(describe(variant, scenario.scenario, turn, index));
      });
      assert.equal(scenario.rereads_required, 0, `${variant} ${scenario.scenario}`);
    }
  }
  assert.deepEqual(rereads, []);
});

// dot rec#10 6365998098 item 3: both fixtures use the Provider's own recovery
// window (store_agent_conversations.py _context_events: back to the third
// user message; conversation_context.py pack_context: the default 4000-byte
// context_budget, a lone newest message as a prefix), never a wider one.
test('the replay journal answers with the Provider recovery window', () => {
  assert.deepEqual(PROVIDER_RECOVERY_WINDOW, { userMessages: 3, budgetBytes: 4000 });
  const journal = syntheticJournal('conversation-w', PROVIDER_RECOVERY_WINDOW);
  for (let turn = 1; turn <= 5; turn++) {
    journal.add('user', `question ${turn}`, 'codex', 's', `e-${turn}-u`);
    journal.add('assistant', `answer ${turn}`, 'codex', 's', `e-${turn}-a`);
  }
  const short = journal.recovery('claude_code', 'h');
  assert.deepEqual(short.messages.map(message => message.content),
    ['question 3', 'answer 3', 'question 4', 'answer 4', 'question 5', 'answer 5']);
  assert.equal(short.omitted_sequence, 4);
  assert.equal(short.truncated, true);
  const { messages, ...packed } = short;
  const packedBytes = Buffer.byteLength(JSON.stringify({ ...packed,
    messages: messages.map(({ sequence, role, content }) => ({ sequence, role, content })) }));
  assert.ok(packedBytes <= 4000);
  // Long messages: only the newest that fit the budget; one too large alone is a prefix.
  const long = syntheticJournal('conversation-l', PROVIDER_RECOVERY_WINDOW);
  for (let turn = 1; turn <= 3; turn++) long.add('user', `${turn} ${'x'.repeat(1500)}`, 'codex', 's', `l-${turn}`);
  assert.deepEqual(long.recovery('claude_code', 'h').messages.map(message => message.sequence), [2, 3]);
  const huge = syntheticJournal('conversation-h', PROVIDER_RECOVERY_WINDOW);
  huge.add('user', 'y'.repeat(6000), 'codex', 's', 'h-1');
  const [prefix] = huge.recovery('claude_code', 'h').messages;
  assert.equal(prefix.truncated, true);
  assert.match(prefix.content, /^y+…$/);
});

test('explicit resume is reused only after a complete visible result, in both fixtures and clients', async () => {
  for (const { variant, scenarios } of await variants()) {
    const scenario = scenarios.find(item => item.scenario === 'explicit_resume');
    assert.ok(scenario, variant);
    assert.deepEqual(scenario.checks.filter(check => !check.pass), [], variant);
    const complete = scenario.detail.filter(turn => turn.note === 'complete after explicit resume');
    assert.equal(complete.length, 2, variant);
    for (const turn of complete) {
      assert.equal(turn.messages_sent, 0, `${variant} ${turn.client}`);
      assert.equal(turn.correctness.ok, true);
    }
  }
});
