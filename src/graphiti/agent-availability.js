import { coversClient } from '../agents/source-applications.js';

// Why an Agent may not work in this client now, or null: one vocabulary for
// task entry's selection and the FLA picker. status is the profile status;
// allowedClients its stored client list (coversClient applies the aliases).
export function agentUnavailableReason({ status, allowedClients }, sourceApplication) {
  if (status === 'archived') return 'dismissed';
  if (status !== 'active') return 'inactive';
  return coversClient(allowedClients, sourceApplication ?? 'other') ? null : 'client_not_allowed';
}
