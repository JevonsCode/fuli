// Demand is an on-demand advisory view, never task-entry context or hiring authority.
export async function withOccupationDemand(application, input, plan) {
  const requested = { main: input.occupation, independent: input.independentWork?.occupation,
    verification: input.verificationOccupation ?? 'testing' };
  const occupations = [...new Set((plan.divisionPlan?.workstreams ?? [])
    .map(stream => requested[stream.id]).filter(Boolean))];
  if (!occupations.length || plan.status === 'unassigned') return plan;
  const task = await application.taskContextRegistry.context(input.taskContextToken, input.sourceApplication);
  try {
    const demand = await application.personal.occupationDemand({ personal_space_id: application.config.personal.spaceId,
      personal_project_id: task.personalProjectId, occupations });
    return { ...plan, staffingDemand: { ...demand, status: 'available',
      proposals: demand.occupations.filter(row => row.task_count > demand.task_threshold && !row.has_dedicated)
        .map(row => ({ occupation: row.occupation, taskCount: row.task_count, action: 'propose_dedicated',
          requiresConfirmation: true })),
      guidance: 'Reuse qualified same-occupation Agents first; cross-project work still requires an approved loan. Dedicated hiring is only a proposal for Bole and the user; no assignment or recruitment is authorized.' } };
  } catch {
    // Availability is unknown, not zero demand or permission to hire a replacement.
    return { ...plan, staffingDemand: { status: 'unavailable', proposals: [] } };
  }
}
