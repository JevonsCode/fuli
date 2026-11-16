// FULI's four built-in roles as the console names them: Jefa, Bole, Tonborg
// and Astro (the Provider's `employee.assistant`). This is the console's
// declaration of who they are. The Node side declares the same four in
// src/employees/fixed-roles.js and the Provider in
// graph-provider/fuli_graph/fixed_roles.py; test/fixed-roles-contract.test.js
// keeps the three alike. fla-mention.ts spells the four itself, because Node
// tests load that file and it can import nothing; the same test covers it.
export const ROLE_AGENT_IDS = {
  jefa: 'employee.jefa',
  bole: 'employee.bole',
  tonborg: 'employee.tonborg',
  astro: 'employee.assistant',
} as const
export type BuiltInRole = keyof typeof ROLE_AGENT_IDS
