// The rec#15 PR4 gates (D-29.5, D-29.10, D-29.11) on acceptance/context-delivery-replay:
// every scenario through the real hook entries, with the tiny and the scaled
// synthetic fixture. Synthetic transcripts and Provider only; bytes, no tokens.
import assert from 'node:assert/strict';
import test from 'node:test';
import { measure } from '../acceptance/context-delivery-replay/run.js';
import { markdownTable } from '../acceptance/context-delivery-replay/report.js';
import { FIXTURES } from '../acceptance/context-delivery-replay/fixtures.js';

// The exact encoding a complete frame with preferences adds (D-29.10): its
// 12-hex revision field. The per-turn allowance is this measured byte count.
const REVISION_FIELD_BYTES = Buffer.byteLength(',"revision":"0123456789ab"', 'utf8');
// A turn that carries a recovery.withdrawn block may exceed by this much more (D-29.5).
const WITHDRAWN_ALLOWANCE_BYTES = 128;
// D-29.5: strictly below the uncached baseline with the scaled fixture.
const STRICTLY_SMALLER = ['acceptance', 'edit_withdraw', 'scene_switch', 'compact_resume', 'delivery_failure'];

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
