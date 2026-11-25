// A repeatable, benign fixture for the single-skill paired evaluation. It is a
// tiny text project and one synthetic workflow stored through the production
// Agent workflow port (propose, then the person confirms). No fixture loads or
// runs code: the task is a few text files, a prompt and file checks.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createAgentWorkflows } from '../../src/agent-workflows/port.js';

export const FIXTURE_OWNER = Object.freeze({
  personalSpaceId: 'synthetic-space',
  agentId: 'synthetic-fla',
  personalProjectId: 'synthetic-project'
});

export const FIXTURE_PROJECT_FILES = Object.freeze({
  VERSION: '1.4.0\n',
  'NOTES.md': '- Fix retry handling in the notification relay.\n',
  'README.md': 'Synthetic fixture for the FULI single-skill paired evaluation. It holds no real data.\n'
});

// The stored workflow is deliberately small and benign. The release-tag
// convention is not written in the repository, so the off arm cannot read it;
// the on arm may learn it only from the one selected workflow.
export const FIXTURE_WORKFLOW = Object.freeze({
  name: 'Release tag convention',
  purpose: 'Write this repository\'s release tag for a version: the version prefixed with rel-, with no leading v.',
  steps: Object.freeze([
    Object.freeze({ title: 'Read the version', detail: 'Read VERSION and the release note in NOTES.md.' }),
    Object.freeze({ title: 'Use the release-tag convention',
      detail: 'The tag is the version prefixed with rel-, with no leading v. Example: 1.4.0 becomes rel-1.4.0.' }),
    Object.freeze({ title: 'Write only the tag',
      detail: 'Write the tag to release.txt with no explanation, and change no other file.' })
  ])
});

export const FIXTURE_TASKS = Object.freeze({
  positive: Object.freeze({
    id: 'release-tag',
    kind: 'positive',
    prompt: 'Read VERSION and NOTES.md in this repository. Create release.txt containing this version\'s release tag, '
      + 'using the repository\'s release-tag convention. Write only the tag. Do not change any other file.',
    checks: Object.freeze([
      Object.freeze({ type: 'file-equals', path: 'release.txt', value: 'rel-1.4.0' }),
      Object.freeze({ type: 'file-unchanged', path: 'VERSION' }),
      Object.freeze({ type: 'file-unchanged', path: 'NOTES.md' }),
      Object.freeze({ type: 'only-changed', allowed: Object.freeze(['release.txt']) })
    ]),
    // The deterministic seam is data, not a model: the off arm writes the
    // plausible v-prefix; the on arm writes what the selected workflow says.
    standIn: Object.freeze({
      offFiles: Object.freeze({ 'release.txt': 'v1.4.0\n' }),
      onFiles: Object.freeze({ 'release.txt': 'rel-1.4.0\n' })
    })
  }),
  negative: Object.freeze({
    id: 'unrelated-arithmetic',
    kind: 'negative',
    prompt: 'Calculate 17 + 25. Write only the numeric result in answer.txt. '
      + 'Do not change any other file and do not create any other file.',
    checks: Object.freeze([
      Object.freeze({ type: 'file-equals', path: 'answer.txt', value: '42' }),
      Object.freeze({ type: 'only-changed', allowed: Object.freeze(['answer.txt']) })
    ]),
    forbidden: Object.freeze({ files: Object.freeze(['release.txt']), markers: Object.freeze(['rel-']) }),
    standIn: Object.freeze({ files: Object.freeze({ 'answer.txt': '42\n' }) })
  })
});

// A fixed person decision and a fixed workflow id make the fixture identical
// from run to run. The store is created by the same port FULI uses.
export function createFixtureStore({ path, now = () => new Date('2026-11-25T00:00:00.000Z'),
  newId = () => 'workflow-release-tag' } = {}) {
  if (!path) throw new TypeError('createFixtureStore needs a path');
  mkdirSync(dirname(path), { recursive: true });
  const workflows = createAgentWorkflows({ path, now, newId });
  try {
    const proposal = workflows.propose(FIXTURE_OWNER, {
      name: FIXTURE_WORKFLOW.name,
      purpose: FIXTURE_WORKFLOW.purpose,
      steps: FIXTURE_WORKFLOW.steps,
      source: 'agent'
    });
    workflows.decide({ personalSpaceId: FIXTURE_OWNER.personalSpaceId, workflowId: proposal.workflow.workflowId,
      decision: 'confirm', version: 1 });
    return { path, workflowId: proposal.workflow.workflowId, version: 1 };
  } finally {
    workflows.close();
  }
}
