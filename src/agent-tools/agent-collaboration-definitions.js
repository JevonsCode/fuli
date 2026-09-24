import { objectSchema, stringSchema, arraySchema, enumSchema } from './schema.js';
const id = { ...stringSchema(), minLength: 1, maxLength: 128 };
const task = { taskContextToken: { ...id, maxLength: 160 } };
const quality = { personalSpaceId: id, personalProjectId: id, taskId: id,
  artifactRevision: { ...id, maxLength: 160 } };
export const AGENT_COLLABORATION_DEFINITIONS = [
  { name: 'get_agent_quality_gate', title: 'READ · Artifact verification and escalation',
    description: 'Check current artifact verification and model capability floor. Exact artifact revision required. Two failures at one tier escalate; two top-tier failures require human direction. A recommended model is not an executed worker.',
    inputSchema: objectSchema(quality, Object.keys(quality)) },
  { name: 'record_agent_verification', title: 'WRITE · Record factual verification',
    description: 'Record a real test/acceptance attempt after reporting the verifier actual executor run. Supply exact artifact revision and bounded evidence references. The Provider derives capability tier from preflight; repeated attempt IDs are immutable. Report failed honestly. Complete only after the current artifact passes.',
    inputSchema: objectSchema({ ...quality, ...task, attemptId: { ...id, minLength: 8 },
      outcome: enumSchema(['pass','fail']), evidenceRefs: arraySchema({ ...id, maxLength: 512 }, { minItems: 1, maxItems: 12 }),
      runId: id, executorId: id, provider: id, model: { ...id, maxLength: 256 } },
    [...Object.keys(quality), 'taskContextToken','attemptId','outcome','evidenceRefs','runId','executorId','provider','model']) },
  { name: 'plan_agent_collaboration', title: 'READ · Match specialists and verification clients',
    description: 'Evaluate a bounded workstream before execution. Inspect qualified local and cross-project specialists, project lead, pending loans and registered client availability. Returns an optional 15-second preference question and task-local authorized default; silence never grants permission or creates global preferences. Does not launch workers or read peer memories.',
    inputSchema: objectSchema({ ...task, workKind: id, requiredCapabilities: arraySchema(id, { maxItems: 16 }) }, ['taskContextToken', 'workKind']) },
  { name: 'request_agent_loan', title: 'WRITE · Request a specialist from another project',
    description: 'Destination project lead requests a task-scoped specialist loan from the source project lead. Requires an active target task. The source lead must approve before assignment or execution; no source project private context is shared.',
    inputSchema: objectSchema({ ...task, sourceProjectId: id, specialistId: id, targetTaskId: id,
      objective: { ...id, maxLength: 2000 }, idempotencyKey: { ...id, minLength: 8 } },
    ['taskContextToken', 'sourceProjectId', 'specialistId', 'targetTaskId', 'objective', 'idempotencyKey']) },
  { name: 'decide_agent_loan', title: 'WRITE · Decide or return a specialist loan',
    description: 'The source project lead approves/rejects in its own scoped task. Either project lead can close the loan. Approval creates a separate destination assignment; destination task completion automatically closes it. It does not transfer private memory or authorize new tools/executors.',
    inputSchema: objectSchema({ ...task, loanId: id, decision: enumSchema(['approve','reject','close']) }, ['taskContextToken','loanId','decision']) },
  { name: 'list_agent_loans', title: 'READ · Project specialist loans',
    description: 'List pending and recent specialist loans for one authorized project, without loading peer memory.',
    inputSchema: objectSchema({ personalSpaceId: id, personalProjectId: id }, ['personalSpaceId','personalProjectId']) }
];
