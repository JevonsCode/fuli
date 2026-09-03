// Management is a task-entry capability, not a replacement for the specialist
// role/executor chosen by FULI. Never persist the user's prompt or start a model.
export async function employeeTaskEntry({ registry, recruitment, workspace }, input) {
  if (!input.personalProjectId) return { status: 'project_unresolved', managers: [], worker_started: false };
  const managers = [];
  let unavailable = false;
  for (const { manifest, runtimeStatus } of registry.catalog()) {
    if (!manifest.taskEntry) continue;
    try {
      const context = await recruitment.authorize({ templateId: manifest.id, personalProjectId: input.personalProjectId, sourceApplication: input.sourceApplication });
      if (runtimeStatus !== 'ready') { unavailable = true; continue; }
      const resolved = await workspace({ templateId: manifest.id, personalProjectId: input.personalProjectId, sourceApplication: input.sourceApplication });
      const runtime = await registry.runtime(manifest.id);
      const definition = (await runtime.describeTools()).find(tool => tool.name === manifest.taskEntry.boardTool);
      if (!definition || definition.permission !== 'board.read' || !manifest.permissions.includes('board.read')) {
        unavailable = true; continue;
      }
      const board = await runtime.callTool(manifest.taskEntry.boardTool, { limit: 8 }, resolved);
      managers.push({
        template_id: manifest.id, agent_id: context.agentId, name: manifest.name,
        personal_project_id: context.project.id, scope_mode: context.management.mode,
        title_mode: context.management.titleMode, title_style: context.management.titleStyle,
        board: { version: board.version, total: board.total, truncated: board.truncated,
          items: (board.items ?? []).slice(0, 8).map(item => ({
            id: item.id, title: item.title, status: item.status, priority: item.priority,
            workType: item.workType, updatedAt: item.updatedAt,
          })) },
        session: { sourceApplication: input.sourceApplication ?? 'other', sessionId: input.sourceSessionId ?? input.sessionId ?? null },
        tools: { discover: 'list_employee_tools', call: 'call_employee_tool',
          read_board: manifest.taskEntry.boardTool, prepare_title: manifest.taskEntry.titleTool ?? null },
        guidance: 'Route actionable work in this project through this manager: match existing board items, or create a concise task for new work. Keep conversation-only questions out of the backlog. Update linked items as evidence arrives; Agent completion goes to review, never human-confirmed done. When this conversation materially advances a matched task and its progress was actually recorded, end the user-facing response with a short receipt naming that task; never claim a task update that did not succeed. Before creating or editing, discover the installed tool schemas and preserve versions/idempotency. If title_mode is auto or suggest, prepare a title from only this session’s linked work item IDs. Auto applies only when the current host exposes a native session rename capability and the exact target session is known: execute the returned action in that host, then report its actual result. Never edit client databases or transcripts, invent an execution receipt, rename another session, or override a locked/manual title. Do not start an additional model solely for this entry.'
      });
    } catch (error) {
      // Excluded/unassigned/inactive projects never reach the plugin runtime.
      if (!['assignment_required', 'project_not_found'].includes(error?.code)) unavailable = true;
    }
  }
  return { status: unavailable ? 'degraded' : managers.length ? 'ready' : 'not_managed', managers, worker_started: false };
}
