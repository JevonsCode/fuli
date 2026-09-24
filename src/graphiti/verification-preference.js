// Preference selection never authorizes an executor. Existing user routing rules
// win; otherwise the default applies only to the current task.
export function verificationPreference({ executors, rules = [], projectId, lockedExecutorIds = null, now = Date.now() }) {
  const eligible = executors.filter(executor => executor.registrationStatus === 'registered'
    && executor.permissionStatus === 'authorized' && executor.preflightStatus === 'passed'
    && executor.workspacePermission && executor.healthStatus !== 'unhealthy'
    && (!executor.healthRequired || executor.healthStatus === 'healthy')
    && executor.availableModels?.some(model => model.available)
    && (!lockedExecutorIds || lockedExecutorIds.includes(executor.executorId)));
  const applicable = rules.filter(rule => rule.status === 'active' && rule.workKind === 'test_validation'
    && (rule.scope === 'global' || rule.scope === 'space' || rule.scope === 'project' && rule.personalProjectId === projectId))
    .sort((a, b) => ({ project: 3, space: 2, global: 1 }[b.scope] - { project: 3, space: 2, global: 1 }[a.scope])
      || (a.priority ?? 100) - (b.priority ?? 100));
  const preference = applicable[0];
  const preferred = (preference?.executorIds ?? []).map(id => eligible.find(item => item.executorId === id)).find(Boolean);
  eligible.sort((a, b) => (a.globalPriority ?? 100) - (b.globalPriority ?? 100) || a.executorId.localeCompare(b.executorId));
  return { status: eligible.length ? 'available' : 'blocked', recommendedExecutorId: preferred?.executorId ?? eligible[0]?.executorId ?? null,
    choiceSource: preferred ? 'user_rule' : 'task_default', scope: preferred ? preference.scope : 'task',
    shouldAsk: !preference && eligible.length > 1,
    expiresAt: new Date(now + 15000).toISOString(), timeoutSeconds: 15,
    eligibleExecutors: eligible.map(item => ({ executorId: item.executorId, name: item.displayName })),
    persistChoiceWith: 'upsert_executor_routing_rule', workKind: 'test_validation',
    guidance: 'If shouldAsk, offer the optional choice once. If unanswered at expiresAt, use recommendedExecutorId for this task only. Ask project vs global scope only for a user-selected preference; silence creates no durable rule. Recheck availability before dispatch. Never grant permissions, authenticate or spend newly authorized money from a timeout.' };
}
