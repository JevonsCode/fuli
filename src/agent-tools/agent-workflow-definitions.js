import { arraySchema, boundedString, enumSchema, objectSchema } from './schema.js';

// An Agent's own workflows (rec#60 D-78): it proposes, the person confirms in
// the console, it reads the index first and one workflow's steps on demand.
// Full profile only, chat reaches them through list_agent_interfaces/fuli_call;
// the owner is the task's bound Agent, so none takes an agentId.
const token = boundedString(256);
const workflowId = boundedString(200);
const workMapList = arraySchema(boundedString(600), { maxItems: 10 });

export const AGENT_WORKFLOW_DEFINITIONS = [
  {
    name: 'propose_agent_workflow',
    title: 'WRITE · Propose your workflow',
    description: 'For work you repeat: steps from a list_workflow_candidates candidateId or your own; workflowId proposes a new version. A Skill draft from a draftable topic names its experienceIds and needs workMap (purpose is the goal; questions: at most 3, never what docs or history answer). Only the person activates it; nothing runs by itself.',
    inputSchema: objectSchema({
      taskContextToken: token,
      workflowId,
      candidateId: boundedString(200),
      name: boundedString(80),
      purpose: boundedString(300),
      steps: arraySchema(objectSchema({ title: boundedString(120), detail: boundedString(600) }, ['title']),
        { minItems: 1, maxItems: 20 }),
      experienceIds: arraySchema(boundedString(256), { minItems: 3, maxItems: 10 }),
      workMap: objectSchema({ inputs: workMapList, outputs: workMapList, dependencies: workMapList, branches: workMapList,
        acceptance: workMapList, questions: arraySchema(boundedString(600), { maxItems: 3 }) }, ['inputs', 'outputs', 'acceptance'])
    }, ['taskContextToken', 'name', 'purpose'])
  },
  {
    name: 'list_agent_workflows',
    title: 'READ · Index your workflows',
    description: 'Your proposed and active workflows without steps (stepCount, approxTokens, last run); read one when needed. draftable: topics with 3+ kept experiences, ready for a Skill draft.',
    inputSchema: objectSchema({ taskContextToken: token }, ['taskContextToken'])
  },
  {
    name: 'read_agent_workflow',
    title: 'READ · Your active workflow\'s steps',
    description: 'The confirmed steps of one active workflow.',
    inputSchema: objectSchema({ taskContextToken: token, workflowId }, ['taskContextToken', 'workflowId'])
  },
  {
    name: 'record_agent_workflow_run',
    title: 'WRITE · Record a workflow run',
    description: 'After following an active workflow, record its outcome.',
    inputSchema: objectSchema({
      taskContextToken: token,
      workflowId,
      taskId: boundedString(200),
      outcome: enumSchema(['done', 'stopped', 'failed']),
      note: boundedString(500)
    }, ['taskContextToken', 'workflowId', 'outcome'])
  }
];
