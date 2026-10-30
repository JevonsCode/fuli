import { EMPLOYEE_TOOL_DEFINITIONS } from './employee-definitions.js';
import { AGENT_APP_TOOL_DEFINITIONS } from './agent-app-definitions.js';
import { JUDGMENT_TOOL_DEFINITIONS } from './judgment-definitions.js';
import { MODEL_BACKEND_DEFINITIONS } from './model-backend-definitions.js';
import { STANDING_ASSIGNMENT_DEFINITIONS } from './standing-assignment-definitions.js';
import { AGENT_SERVICE_DEFINITIONS } from './agent-service-definitions.js';
import { AGENT_WORKFLOW_DEFINITIONS } from './agent-workflow-definitions.js';
import { TASK_RUN_DEFINITIONS } from './task-run-definitions.js';
import { TASK_PREFERENCE_DEFINITIONS } from './task-preference-definitions.js';
import { AGENT_INTERFACE_DEFINITIONS } from './interface-definitions.js';
import { AGENT_ATTENTION_DEFINITIONS } from './agent-attention-definitions.js';
import { AGENT_SCORE_CARD_DEFINITIONS } from './agent-score-card-definitions.js';
import { TASK_ENTRY_DEFINITIONS } from './task-entry-definitions.js';
import { KNOWLEDGE_DEFINITIONS } from './knowledge-definitions.js';
import { KNOWLEDGE_SPACE_DEFINITIONS, PUBLIC_PROJECT_DEFINITIONS } from './project-space-definitions.js';
import { PROJECT_AGENT_TOOL_DEFINITIONS } from './project-agent-tool-definitions.js';
import { EXECUTOR_ROUTING_DEFINITIONS } from './executor-routing-definitions.js';
import { KNOWLEDGE_CURATION_DEFINITIONS } from './knowledge-curation-definitions.js';

// Every graph tool in tools/list order; the order is part of the bytes each
// session pays for (test/token-budget.test.js).
export const GRAPH_TOOL_DEFINITIONS = [
  ...AGENT_ATTENTION_DEFINITIONS,
  ...AGENT_INTERFACE_DEFINITIONS,
  ...EMPLOYEE_TOOL_DEFINITIONS,
  ...AGENT_APP_TOOL_DEFINITIONS,
  ...JUDGMENT_TOOL_DEFINITIONS,
  ...MODEL_BACKEND_DEFINITIONS,
  ...AGENT_SCORE_CARD_DEFINITIONS,
  ...TASK_RUN_DEFINITIONS,
  ...STANDING_ASSIGNMENT_DEFINITIONS,
  ...AGENT_SERVICE_DEFINITIONS,
  ...AGENT_WORKFLOW_DEFINITIONS,
  ...TASK_PREFERENCE_DEFINITIONS,
  ...TASK_ENTRY_DEFINITIONS,
  ...KNOWLEDGE_DEFINITIONS,
  ...KNOWLEDGE_SPACE_DEFINITIONS,
  ...PROJECT_AGENT_TOOL_DEFINITIONS,
  ...EXECUTOR_ROUTING_DEFINITIONS,
  ...KNOWLEDGE_CURATION_DEFINITIONS,
  ...PUBLIC_PROJECT_DEFINITIONS
];
