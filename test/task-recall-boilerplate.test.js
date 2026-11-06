// rec#88: instructions a client appends to every prompt chose the recall
// topics and took the focus slots, so the same release items came back for
// every turn. The plan reads the task's own text. Synthetic prompts only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planTaskKnowledgeRecall, recallTaskKnowledge } from '../src/graphiti/task-knowledge-recall.js';
import { promptSentenceKeys, taskStatement } from '../src/graphiti/task-prompt-statement.js';
import { createSessionPromptSentences, SESSION_PROMPT_SENTENCES_FILE } from '../src/graphiti/session-prompt-sentences.js';

const FOOTER = 'Environment: this directory is a small Node project on Windows. The shell is Git Bash and `node` is on PATH. '
  + 'Do not commit, push, or create branches; leave your changes in the working tree.\n'
  + 'Work only from this checkout: do not browse the web or read folders outside it.';
const TASKS = [
  'Add a `NegativeAmountError` to `src/errors.js` following our error code convention.',
  'Make `fetchRate` in `src/rates.js` retry failed requests following the retry policy we agreed for the rates client.',
  'Add `src/health.js` returning the URL of the staging API health endpoint.'
];
const categories = plan => plan.trigger_categories;

test('an appended environment note neither chooses topics nor takes the focus, even after one newline', () => {
  for (const task of TASKS) {
    const alone = planTaskKnowledgeRecall(task);
    const withFooter = planTaskKnowledgeRecall(`${task}\n${FOOTER}`);
    assert.deepEqual(categories(withFooter), categories(alone), task);
    assert.deepEqual(withFooter.queries.slice(0, alone.queries.length), alone.queries, task);
    assert.ok(withFooter.queries.every(query => !/Git Bash|Windows|PATH/.test(query)), JSON.stringify(withFooter.queries));
  }
});

test('"Git Bash" names a shell, not a delivery; git operations still do', () => {
  assert.equal(categories(planTaskKnowledgeRecall('The shell is Git Bash on this machine, list the modules.'))
    .includes('release_delivery'), false);
  assert.equal(categories(planTaskKnowledgeRecall('Install Git for Windows and list the modules.')).includes('release_delivery'), false);
  assert.ok(categories(planTaskKnowledgeRecall('Tag the build with git and ship it')).includes('release_delivery'));
});

test('a prohibition alone never chooses a topic or a query', () => {
  for (const prompt of ['Do not commit, push, or create branches.', 'Never touch the release notes.',
    "Don't change the architecture decision record.", '不要修改发布脚本。']) {
    assert.equal(planTaskKnowledgeRecall(prompt).status, 'not_needed', prompt);
  }
  // The task's own clause after a prohibition still plans.
  assert.ok(categories(planTaskKnowledgeRecall('Do not change the tests. Deploy the beta to staging.')).includes('release_delivery'));
  assert.ok(categories(planTaskKnowledgeRecall('不要改测试，按我们约定的重试策略改 fetchRate')).includes('project_convention'));
});

test('a sentence the session already sent with every prompt is discounted; a whole repeated prompt is not', () => {
  // No note label, no prohibition: a plain sentence a script appends to every prompt.
  const tail = 'Deploy previews are rebuilt by CI after every change, so keep the release branch green.';
  const first = `${TASKS[0]}\n${tail}`;
  assert.ok(categories(planTaskKnowledgeRecall(first)).includes('release_delivery'), 'the first prompt cannot tell yet');
  const earlier = new Set(promptSentenceKeys(first));
  const second = planTaskKnowledgeRecall(`${TASKS[1]}\n${tail}`, { earlierSentences: earlier });
  assert.deepEqual(categories(second), categories(planTaskKnowledgeRecall(TASKS[1])));
  assert.ok(second.queries.every(query => !/release|deploy/i.test(query)), JSON.stringify(second.queries));
  // The same request again is still that request.
  assert.deepEqual(planTaskKnowledgeRecall(first, { earlierSentences: earlier }), planTaskKnowledgeRecall(first));
  assert.equal(taskStatement(`${TASKS[2]}\n${tail}`, earlier), TASKS[2]);
});

test('the session store keeps sentence hashes only, per session, bounded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-prompt-sentences-'));
  try {
    let clock = 0;
    const store = createSessionPromptSentences({ dataDir: directory, now: () => ++clock });
    const first = `${TASKS[0]}\n${FOOTER}`;
    assert.equal(store.exchange('claude_code', 'session-a', promptSentenceKeys(first)).size, 0);
    const earlier = store.exchange('claude_code', 'session-a', promptSentenceKeys(`${TASKS[1]}\n${FOOTER}`));
    assert.deepEqual([...earlier].sort(), promptSentenceKeys(first).sort());
    assert.equal(store.exchange('claude_code', 'session-b', []).size, 0, 'another session has its own');
    assert.equal(store.exchange('codex', 'session-a', []).size, 0, 'another client has its own');
    const text = await readFile(join(directory, SESSION_PROMPT_SENTENCES_FILE), 'utf8');
    assert.doesNotMatch(text, /Negative|fetchRate|Git Bash|session-a|claude_code/);
    for (let index = 0; index < 40; index++) store.exchange('claude_code', `session-${index}`, promptSentenceKeys(`Synthetic task ${index}.`));
    assert.ok(Object.keys(JSON.parse(await readFile(join(directory, SESSION_PROMPT_SENTENCES_FILE), 'utf8')).sessions).length <= 32);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the entry recall searches each prompt by its own words across a session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-prompt-sentences-'));
  try {
    const calls = [];
    const application = {
      config: { personal: { spaceId: 'personal-space' } },
      consoleUrl: 'http://127.0.0.1:2727',
      sessionPromptSentences: createSessionPromptSentences({ dataDir: directory }),
      async searchKnowledge(input) { calls.push(input.query); return { facts: [], entities: [] }; }
    };
    const recalls = [];
    for (const task of TASKS) {
      recalls.push(await recallTaskKnowledge(application, { personalProjectId: 'synthetic' }, `${task}\n${FOOTER}`,
        { sourceApplication: 'claude_code', sessionId: 'session-a' }));
    }
    assert.ok(recalls.every(recall => !recall.trigger_categories.includes('release_delivery')), JSON.stringify(recalls.map(categories)));
    assert.ok(calls.some(query => /retry/.test(query)) && calls.some(query => /staging api health/.test(query)), JSON.stringify(calls));
    assert.ok(calls.every(query => !/Git Bash|Windows|checkout/.test(query)), JSON.stringify(calls));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
