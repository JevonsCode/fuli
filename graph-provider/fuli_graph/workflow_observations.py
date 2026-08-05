from .models import KnowledgeCommit
from .workflow_observation_models import WorkflowTransitionObservation


async def record_workflow_transition_observation(
    store,
    actor: dict,
    request: WorkflowTransitionObservation,
):
    basis = {
        'existence_reason': (
            'An Agent reported one completed-action transition through the MCP seam.'
        ),
        'quadrant_reason': (
            'Behavioral sequence evidence is not user consent or authorization.'
        ),
        'proposed_by': {
            'kind': 'agent',
            'label': 'mcp-host-workflow-observer',
        },
    }
    commit = KnowledgeCommit.model_validate({
        'space_id': request.personal_space_id,
        'personal_project_id': request.personal_project_id,
        'episode': {
            'idempotency_key': request.observation_id,
            'session_id': request.host_session_id,
            'name': (
                f'Observed {request.from_step.name} then {request.to_step.name}'
            )[:512],
            'source_kind': 'workflow_action_observation',
            'source_description': (
                'One Agent-reported action transition submitted through the Fuli MCP host.'
            ),
            'source_application': request.source_application or 'other',
            'source_turn_id': request.source_turn_id,
            'reference_time': request.observed_at,
            'summary': request.evidence_summary,
            'sensitivity': request.sensitivity,
            'entities': [
                _workflow_step(request.from_step, basis),
                _workflow_step(request.to_step, basis),
            ],
            'relationships': [{
                'key': request.workflow_key,
                'source': request.from_step.action_id,
                'target': request.to_step.action_id,
                'type': 'RECOMMENDS_NEXT',
                'fact': request.evidence_summary,
                'valid_at': request.observed_at,
                'origin_quadrant': 'unknown_known',
                'current_quadrant': 'unknown_known',
                'epistemic_status': 'observed',
                'confirmation_status': 'pending',
                'confirmation_basis': basis,
                'reasoning_summary': (
                    'Agent-reported transition; the MCP host attests only '
                    'session, time, and observation identity; no authority.'
                ),
                'attributes': {
                    'workflowCondition': request.condition,
                    'observationKind': 'completed_action_transition',
                },
            }],
        },
    })
    return await store.commit_workflow_observation(actor, commit)


def _workflow_step(step, basis: dict) -> dict:
    return {
        'key': step.action_id,
        'name': step.name,
        'type': 'WorkflowStep',
        'summary': step.summary or f'Reported completed action: {step.name}',
        'origin_quadrant': 'unknown_known',
        'current_quadrant': 'unknown_known',
        'epistemic_status': 'observed',
        'confirmation_status': 'pending',
        'confirmation_basis': basis,
        'reasoning_summary': (
            'The Agent reported the action completion; reuse remains unconfirmed.'
        ),
    }
