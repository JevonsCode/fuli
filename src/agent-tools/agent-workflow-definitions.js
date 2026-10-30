import { arraySchema, boundedString, enumSchema, objectSchema } from './schema.js';

// An Agent's own workflows (rec#60 D-78): it proposes, the person confirms in
// the console, it reads the index first and one workflow's steps on demand.
// Full profile only, chat reaches them through list_agent_interfaces/fuli_call;
// the owner is the task's bound Agent, so none takes an agentId.
const token = boundedString(256);
const workflowId = boundedString(200);

export const AGENT_WORKFLOW_DEFINITIONS = [
  {
    name: 'propose_agent_workflow',
    title: 'WRITE · Propose your workflow',
    description: 'For work you repeat: steps from a list_workflow_candidates candidateId or your own; workflowId proposes a new version. Only the person activates it, in the console; nothing runs by itself.',
    inputSchema: objectSchema({
      taskContextToken: token,
      workflowId,
      candidateId: boundedString(200),
      name: boundedString(80),
      purpose: boundedString(300),
      steps: arraySchema(objectSchema({ title: boundedString(120), detail: boundedString(600) }, ['title']),
        { minItems: 1, maxItems: 20 })
    }, ['taskContextToken', 'name', 'purpose'])
  },
  {
    name: 'list_agent_workflows',
    title: 'READ · Index your workflows',
    description: 'Your proposed and active workflows without steps (stepCount, approxTokens, last run); read one when needed.',
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
