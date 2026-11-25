import { arraySchema, boundedString, enumSchema, objectSchema } from './schema.js';

// An Agent's own workflows (rec#60 D-78): it proposes, the person confirms in
// the console, it reads the index first and one workflow's steps on demand.
// Full profile only, chat reaches them through list_agent_interfaces/fuli_call;
// the owner is the task's bound Agent, so none takes an agentId.
const token = boundedString(256);
const workflowId = boundedString(200);
const workMapList = arraySchema(boundedString(600), { maxItems: 10 });
const lessonList = arraySchema(boundedString(300), { maxItems: 6 });

export const AGENT_WORKFLOW_DEFINITIONS = [
  {
    name: 'propose_agent_workflow',
    title: 'WRITE · Propose your workflow',
    description: 'For work you repeat: your own steps; workflowId proposes a new version. When the person says 下次也这样做 over a delivery that is already completed and recorded, pass their exact words as personWords with lesson (trigger, scope, pitfalls, acceptanceEvidence): FULI checks the words and the completed delivery in this project and keeps it active at once for later sessions. Other wording, a negation or an example does not count; without a completed delivery this is refused. deliveryRef names that delivery\'s conversation when it is not this session. Without personWords a proposal waits for the person. A Skill draft names experienceIds and needs workMap (purpose is the goal; questions: at most 3, never what docs or history answer). Nothing runs by itself.',
    inputSchema: objectSchema({
      taskContextToken: token,
      workflowId,
      name: boundedString(80),
      purpose: boundedString(300),
      steps: arraySchema(objectSchema({ title: boundedString(120), detail: boundedString(600) }, ['title']),
        { minItems: 1, maxItems: 20 }),
      experienceIds: arraySchema(boundedString(256), { minItems: 3, maxItems: 10 }),
      workMap: objectSchema({ inputs: workMapList, outputs: workMapList, dependencies: workMapList, branches: workMapList,
        acceptance: workMapList, questions: arraySchema(boundedString(600), { maxItems: 3 }) }, ['inputs', 'outputs', 'acceptance']),
      personWords: boundedString(600),
      deliveryRef: boundedString(200),
      lesson: objectSchema({ trigger: boundedString(200), scope: boundedString(300),
        pitfalls: lessonList, acceptanceEvidence: lessonList }, ['trigger', 'scope', 'acceptanceEvidence'])
    }, ['taskContextToken', 'name', 'purpose'])
  },
  {
    name: 'list_agent_workflows',
    title: 'READ · Index your workflows',
    description: 'Your proposed and active workflows without steps (stepCount, approxTokens, last run); read one when needed. lessons: a bounded list of other FLAs\' reusables in this project (trigger, scope), read the same way; lessonsMore means more wait beyond this list. draftable: topics with 3+ kept experiences, ready for a Skill draft.',
    inputSchema: objectSchema({ taskContextToken: token }, ['taskContextToken'])
  },
  {
    name: 'read_agent_workflow',
    title: 'READ · One workflow or lesson\'s steps',
    description: 'The confirmed steps of one active workflow; a lesson in the same project, including another FLA\'s, reads with its trigger, scope, pitfalls and evidence.',
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
