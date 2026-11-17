// FULI's four built-in roles, which every personal space has: Jefa, Bole,
// Tonborg and Astro (package id `assistant`). This is the Node side's one
// declaration of who they are; everything else here names a role through it.
// The Provider provisions the identities and declares the same four in
// graph-provider/fuli_graph/fixed_roles.py, the console in
// web/src/features/agent-profile/fixed-roles.ts. The three cannot import each
// other, so test/fixed-roles-contract.test.js keeps them alike. Imports
// nothing: modules with no other dependency read it too.
const role = (id, agentType) => Object.freeze({
  // The same spelling as employeeAgentId and employeeCapability (manifest.js).
  agentId: `employee.${id}`, capability: `fuli.employee:${id}`, agentType
});

export const FIXED_ROLES = Object.freeze({
  jefa: role('jefa', 'coordinator'),
  bole: role('bole', 'hr'),
  tonborg: role('tonborg', 'durable'),
  assistant: role('assistant', 'durable'),
});

export const JEFA_AGENT_ID = FIXED_ROLES.jefa.agentId;
export const BOLE_AGENT_ID = FIXED_ROLES.bole.agentId;
export const TONBORG_AGENT_ID = FIXED_ROLES.tonborg.agentId;
// Astro receives the conversations no project has claimed yet.
export const ASSISTANT_AGENT_ID = FIXED_ROLES.assistant.agentId;
