"""Recover only the task-only employee already bound to this host lifecycle."""

from .project_agent_context_models import ProjectAgentContextResolution


async def temporary_task_owner(store, actor, request):
    if not request.session_id or not hasattr(store, 'current_task_context'):
        return None
    context = await store.current_task_context(actor, request.personal_space_id,
        request.session_id, request.source_application)
    if not context or context.get('agent_memory_scope') != 'task_only':
        return None
    if (context.get('personal_project_id') != request.personal_project_id
            or (request.turn_id and context.get('turn_id') != request.turn_id)
            or (request.agent_id and context.get('project_agent_id') != request.agent_id)):
        return None
    agent = await store.get_project_agent(actor, request.personal_space_id,
        request.personal_project_id, context['project_agent_id'])
    if (agent.profile.agent_type != 'temporary'
            or agent.temporary_task_id != context.get('coordination_task_id')
            or agent.profile.status != 'active'
            or request.source_application not in agent.profile.allowed_clients):
        return ProjectAgentContextResolution(status='agent_unavailable', reason='agent_unavailable')
    return ProjectAgentContextResolution(status='ready', agent=agent, reason='active_task_owner',
        candidate_count=1, match_basis=['temporary employee bound to this exact host task'], worker_started=False)
