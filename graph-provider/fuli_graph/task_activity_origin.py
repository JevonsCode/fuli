"""Bounded provenance for display; it never grants execution or capture rights."""

from typing import Literal

from pydantic import Field

from .models import StrictModel


class TaskActivityOrigin(StrictModel):
    version: int = Field(strict=True, ge=1, le=1)
    kind: Literal['ai_internal']
    source: Literal['sealed_worker', 'roundtable_delegation']
    purpose: Literal['test', 'input_suggestion', 'consultation', 'delegated_work']


def read_activity_origin(value):
    if value is None:
        return None
    try:
        return TaskActivityOrigin.model_validate_json(value) if isinstance(value, str) \
            else TaskActivityOrigin.model_validate(value)
    except (TypeError, ValueError):
        # A legacy or invalid record has unknown provenance, never human origin.
        return None


def internal_activity_origin(source, work_kind=None):
    # Purpose is a structured execution hint, never inferred from message text.
    if work_kind in {'test', 'test_validation', 'verification', 'acceptance'}:
        purpose = 'test'
    elif work_kind == 'input_suggestion':
        purpose = 'input_suggestion'
    else:
        purpose = 'consultation' if source == 'roundtable_delegation' else 'delegated_work'
    return TaskActivityOrigin(version=1, kind='ai_internal', source=source, purpose=purpose)


async def context_activity_origin(store, actor, request, *, worker_run_id=None):
    if worker_run_id:
        source = 'sealed_worker'
    elif request.delegation_token:
        from fastapi import HTTPException
        from .project_agent_delegations import AgentDelegationCheck
        scope = await store.admit_agent_delegation(actor, AgentDelegationCheck(
            personal_space_id=request.personal_space_id, token=request.delegation_token,
            session_id=request.session_id))
        expected = {'personal_space_id': request.personal_space_id,
                    'personal_project_id': request.personal_project_id,
                    'project_agent_id': request.project_agent_id,
                    'source_application': request.source_application,
                    'session_id': request.session_id}
        if any(scope.get(key) != value for key, value in expected.items()):
            raise HTTPException(403, 'Activity delegation belongs to another task scope')
        source = 'roundtable_delegation'
    else:
        return None
    return internal_activity_origin(source, request.preference_scope.work_kind if request.preference_scope else None)


async def coordination_activity_origin(store, actor, request):
    if not request.task_context_token:
        return None
    from fastapi import HTTPException
    context = await store.get_task_context(actor, request.personal_space_id,
                                           request.task_context_token, request.source_application)
    if context.get('personal_project_id') != request.personal_project_id \
            or (context.get('checkpoint') or {}).get('phase') == 'complete':
        raise HTTPException(409, 'Activity context must be an active task in this project')
    return read_activity_origin(context.get('activity_origin'))
