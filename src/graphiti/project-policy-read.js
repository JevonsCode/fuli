// One read of a project's coordination policy per task entry. The routing
// by lines (task-entry-workstream.js), the named FLA's notice
// (task-entry-named-fla.js) and the team block (project-agent-team-context.js)
// all need the project's lead; within one entry they share this read instead
// of each asking the Provider. Nothing is read until one of them asks, so a
// project without lines reads no more than it did.

// The entry's reader, carried on the project resolution; JSON never serializes it.
export const POLICY_READER = Symbol('policy_reader');

/** A reader of project policies, memoized per project, for one entry. */
export function policyReader(application) {
  const reads = new Map();
  return projectId => {
    if (!reads.has(projectId)) {
      const read = Promise.resolve().then(() => application.personal.getProjectAgentCoordinationPolicy(
        application.config.personal.spaceId, projectId));
      // Each caller handles a failed read its own way; none goes unhandled.
      read.catch(() => {});
      reads.set(projectId, read);
    }
    return reads.get(projectId);
  };
}

/** The reader this entry's resolution carries, or a new one. */
export function entryPolicyReader(application, resolution) {
  return resolution?.[POLICY_READER] ?? policyReader(application);
}

/** The project's lead, or undefined when the policy cannot be read. */
export async function projectLeadOf(readPolicy, projectId) {
  try {
    return (await readPolicy(projectId))?.team_lead_agent_id ?? undefined;
  } catch {
    return undefined;
  }
}
