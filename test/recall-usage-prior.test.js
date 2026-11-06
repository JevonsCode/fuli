import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { usagePriorLookup } from '../src/knowledge-impressions/ranking-prior.js';
import { RecallImpressionsStore } from '../src/knowledge-impressions/store.js';
import { recallTaskKnowledge } from '../src/graphiti/task-knowledge-recall.js';

// rec#63 step 2: the shown/used impressions as a bounded recall ranking prior.
// Synthetic spaces, projects and items only; no real FULI data directory or
// transcript is read.

// The factor of one item with this history, through the lookup recall uses.
const usagePrior = (counts) => usagePriorLookup({ usage: () => new Map(counts ? [['item', counts]] : []) },
  { personalSpaceId: 'space-a', entities: [{ id: 'item' }] })({ id: 'item' });
const MAX_SHIFT = 0.25;

test('an item never shown is neutral, and the factor stays inside its bounds however long the history', () => {
  assert.equal(usagePrior(), 1);
  assert.equal(usagePrior({ shown: 0, used: 0 }), 1);
  for (const shown of [1, 5, 50, 5000]) {
    const never = usagePrior({ shown, used: 0 });
    const always = usagePrior({ shown, used: shown });
    assert.ok(never < 1 && never >= 1 - MAX_SHIFT, `never used, shown ${shown}: ${never}`);
    assert.ok(always > 1 && always <= 1 + MAX_SHIFT, `always used, shown ${shown}: ${always}`);
  }
  // More evidence moves further, and one task moves little.
  assert.ok(usagePrior({ shown: 10, used: 0 }) < usagePrior({ shown: 2, used: 0 }));
  assert.ok(usagePrior({ shown: 1, used: 0 }) > 0.9);
  assert.ok(usagePrior({ shown: 10, used: 10 }) > usagePrior({ shown: 2, used: 2 }));
  // used beyond shown is clamped rather than trusted.
  assert.equal(usagePrior({ shown: 2, used: 9 }), usagePrior({ shown: 2, used: 2 }));
});

function storeIn(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-recall-usage-prior-'));
  const path = join(directory, 'recall-impressions.sqlite');
  const store = new RecallImpressionsStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}

function showTasks(store, { space = 'space-a', prefix, count, facts = [], entities = [], used = [] }) {
  for (let index = 0; index < count; index += 1) {
    const taskContextToken = `fuli-task-${prefix}-${index}`;
    store.recordShown({ taskContextToken, personalSpaceId: space, personalProjectId: 'project-a',
      facts: facts.map(id => ({ id })), entities: entities.map(id => ({ id })) });
    store.markUsed({ taskContextToken, items: used.map(([itemKind, itemId]) => ({ itemKind, itemId, useKind: 'applied' })) });
  }
}

test('usage counts distinct reporting tasks per item within one space and kind', (t) => {
  const { store } = storeIn(t);
  showTasks(store, { prefix: 'a', count: 3, facts: ['rel-1'], entities: ['ent-1'], used: [['relationship', 'rel-1']] });
  showTasks(store, { prefix: 'b', count: 2, facts: ['rel-1'] });
  showTasks(store, { prefix: 'other', space: 'space-b', count: 4, facts: ['rel-1'], used: [['relationship', 'rel-1']] });
  const usage = store.usage({ personalSpaceId: 'space-a', items: [
    { itemKind: 'relationship', itemId: 'rel-1' }, { itemKind: 'entity', itemId: 'ent-1' },
    { itemKind: 'entity', itemId: 'rel-1' }, { itemKind: 'entity', itemId: 'ent-never-shown' }] });
  // The two 'b' tasks reported no use at all, so they say nothing about rel-1.
  assert.deepEqual(Object.fromEntries(usage), { 'rel-1': { shown: 3, used: 3 }, 'ent-1': { shown: 3, used: 0 } });
});

test('reading usage from a store nothing was shown in never creates it', (t) => {
  const { store, path } = storeIn(t);
  assert.equal(store.usage({ personalSpaceId: 'space-a', items: [{ itemKind: 'entity', itemId: 'ent-1' }] }).size, 0);
  assert.equal(existsSync(path), false);
});

test('a store that throws or is missing leaves every item neutral', () => {
  const items = { personalSpaceId: 'space-a', entities: [{ id: 'ent-1' }] };
  assert.equal(usagePriorLookup(undefined, items)({ id: 'ent-1' }), 1);
  assert.equal(usagePriorLookup({ usage: () => { throw new Error('synthetic read failure'); } }, items)({ id: 'ent-1' }), 1);
});

const note = (id, score, extra = {}) => ({ id, space_id: 'personal-space', scope: 'personal',
  name: `Delta Ledger note ${id}`, type: 'ProjectFact', summary: `Delta Ledger amounts (${id}).`,
  defined_project_id: 'delta', scope_distance: 0, confirmation_status: 'confirmed', score, ...extra });

function recallApplication(entities, recallImpressions) {
  return {
    config: { personal: { spaceId: 'personal-space' } },
    consoleUrl: 'http://127.0.0.1:2727',
    recallImpressions,
    async searchKnowledge() { return { facts: [], entities }; }
  };
}
const PROMPT = 'Use the amount format we decided previously for Delta Ledger.';
const recalledIds = async (entities, store) => (await recallTaskKnowledge(recallApplication(entities, store),
  { personalProjectId: 'delta' }, PROMPT)).entities.map(item => item.id);

test('recall moves a used item above a close peer that keeps being shown unused, and drops nothing', async (t) => {
  const { store } = storeIn(t);
  const candidates = [note('shown-unused', 0.80), note('often-used', 0.72), note('third', 0.60)];
  assert.deepEqual(await recalledIds(candidates, store), ['shown-unused', 'often-used', 'third']);
  showTasks(store, { space: 'personal-space', prefix: 'history', count: 6,
    entities: ['shown-unused', 'often-used'], used: [['entity', 'often-used']] });
  assert.deepEqual(await recalledIds(candidates, store), ['often-used', 'shown-unused', 'third']);
});

test('the prior cannot overturn a large score gap or the project-local-first order', async (t) => {
  const { store } = storeIn(t);
  showTasks(store, { space: 'personal-space', prefix: 'history', count: 40,
    entities: ['strong', 'weak', 'inherited'], used: [['entity', 'weak'], ['entity', 'inherited']] });
  assert.deepEqual(await recalledIds([note('strong', 0.9), note('weak', 0.3)], store), ['strong', 'weak']);
  const inherited = note('inherited', 0.95, { defined_project_id: null, inherited_from_project_id: 'parent', scope_distance: 1 });
  assert.deepEqual(await recalledIds([inherited, note('strong', 0.2)], store), ['strong', 'inherited']);
});
