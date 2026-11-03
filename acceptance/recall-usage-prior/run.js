// rec#63 step 2: before/after of the recall usage prior on the synthetic world
// (scenarios.js). It drives the real automatic recall (recallTaskKnowledge) and
// the real impressions store in memory: every simulated task is shown the
// recall's entities, uses each with the item's chance, and records both as task
// entry and checkpoint do. "Before" is the empty store (the prior is neutral);
// "after" is the same frozen queries once the history has accrued. Nothing
// here calls a model, reads FULI data or a transcript.
//
//   node acceptance/recall-usage-prior/run.js [--seeds 1,2,3] [--rounds 8] [--reporting 0.5]
import { parseArgs } from 'node:util';

import { recallTaskKnowledge } from '../../src/graphiti/task-knowledge-recall.js';
import { RecallImpressionsStore } from '../../src/knowledge-impressions/store.js';
import { isMainModule } from '../../src/system/main-module.js';
import { buildWorld, mulberry32 } from './scenarios.js';

const SPACE = 'synthetic-space';
const PROJECT = 'bench';
const K = 3;

const entity = (candidate) => ({ id: candidate.id, space_id: SPACE, scope: 'personal', name: `Bench note ${candidate.id}`,
  type: 'ProjectFact', summary: `Synthetic bench note ${candidate.id}.`, defined_project_id: PROJECT, scope_distance: 0,
  confirmation_status: 'confirmed', score: candidate.score });

async function recalled(store, candidates) {
  const application = { config: { personal: { spaceId: SPACE } }, consoleUrl: 'http://127.0.0.1:2727',
    recallImpressions: store, async searchKnowledge() { return { facts: [], entities: candidates.map(entity) }; } };
  const recall = await recallTaskKnowledge(application, { personalProjectId: PROJECT },
    'Use the method we decided previously for Bench.');
  return recall.entities.map(item => item.id);
}

function scoreQuery(query, ids) {
  const byId = new Map([...query.candidates, ...query.late].map(candidate => [candidate.id, candidate]));
  const top = ids.slice(0, K).map(id => byId.get(id));
  const relevant = [...byId.values()].filter(candidate => candidate.grade === 3);
  return {
    recall: top.filter(candidate => candidate.grade === 3).length / Math.min(K, relevant.length),
    irrelevant: top.filter(candidate => candidate.grade === 0).length / K,
    stale: top.some(candidate => candidate.stale) ? 1 : 0,
    answers: new Set(top.filter(candidate => candidate.grade === 3).map(candidate => candidate.id))
  };
}

async function evaluate(world, store) {
  const rows = [];
  for (const query of world.queries) {
    rows.push({ query, ...scoreQuery(query, await recalled(store, [...query.candidates, ...query.late])) });
  }
  return rows;
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const round = value => Math.round(value * 10000) / 10000;

function summary(rows) {
  const of = kind => rows.filter(row => !kind || row.query.kind === kind);
  const cell = list => ({ recall_at_3: round(mean(list.map(row => row.recall))),
    irrelevant_at_3: round(mean(list.map(row => row.irrelevant))) });
  return { all: { ...cell(of()), stale_in_top_3: round(mean(of().map(row => row.stale))) },
    byKind: Object.fromEntries([...new Set(rows.map(row => row.query.kind))].map(kind => [kind, cell(of(kind))])) };
}

// reporting: the share of tasks whose Agent reports knowledge use at all (a
// client that never sends knowledgeUsage reports nothing, used or not).
export async function measure({ seed = 63, rounds = 8, reporting = 1 } = {}) {
  const world = buildWorld({ seed });
  const store = new RecallImpressionsStore(':memory:');
  const random = mulberry32(seed * 7919);
  try {
    const before = await evaluate(world, store);
    let task = 0;
    for (let round = 0; round < rounds; round += 1) {
      for (const query of world.queries) {
        const byId = new Map(query.candidates.map(candidate => [candidate.id, candidate]));
        const ids = await recalled(store, query.candidates);
        const taskContextToken = `fuli-task-bench-${seed}-${task += 1}`;
        store.recordShown({ taskContextToken, personalSpaceId: SPACE, personalProjectId: PROJECT,
          entities: ids.map(id => ({ id })) });
        const reports = random() < reporting;
        const used = ids.filter(id => random() < byId.get(id).useChance && reports);
        store.markUsed({ taskContextToken, items: used.map(itemId => ({ itemKind: 'entity', itemId, useKind: 'applied' })) });
      }
    }
    const after = await evaluate(world, store);
    // A direct answer that was in a query's top 3 before and is not after.
    const lostAnswers = before.map((row, index) => [...row.answers].filter(id => !after[index].answers.has(id)))
      .flat().length;
    return { seed, rounds, reporting, tasks: task, before: summary(before), after: summary(after), lost_answers: lostAnswers };
  } finally {
    store.close();
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { seeds: { type: 'string', default: '1,2,3,4,5' },
    rounds: { type: 'string', default: '8' }, reporting: { type: 'string', default: '1' } } });
  const results = [];
  for (const seed of values.seeds.split(',').map(Number)) results.push(await measure({ seed, rounds: Number(values.rounds),
    reporting: Number(values.reporting) }));
  console.log(JSON.stringify(results, null, 2));
}
