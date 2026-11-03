"""Bole's declared recruitment role and profile, independent of graph persistence."""

from fastapi import HTTPException

from .project_agent_models import ProjectAgentProfile
from .project_agent_occupation_models import ProjectAgentOccupationInput


def recruitment_occupation(request):
    if request.staffing_intent == 'default_lead':
        return ProjectAgentOccupationInput(role='lead')
    if (request.work_kind == 'assistant' and not request.recruitment_occupation
            or request.recruitment_occupation and request.recruitment_occupation.role == 'assistant'):
        raise HTTPException(422, 'use the fixed global employee.assistant; assistants cannot be recruited')
    if request.recruitment_occupation:
        return request.recruitment_occupation
    # Bole records this exact work-kind decision; free text is never classified.
    roles = {
        'engineering': 'engineering', 'testing': 'testing',
        'management': 'management', 'lead': 'lead',
        'implementation': 'engineering', 'architecture': 'engineering',
        'maintenance': 'engineering', 'code_review': 'engineering',
        'review': 'testing', 'verification': 'testing', 'test_validation': 'testing',
        'planning': 'management', 'project_context': 'lead',
        'project_management': 'management', 'design': 'design',
        'research': 'research', 'writing': 'writing', 'data': 'data',
        'operations': 'operations', 'product': 'product',
    }
    role = roles.get(request.work_kind)
    if not role:
        # Say what would work instead (rec#69): a known work kind, an explicit
        # occupation, or an existing FLA, so a one-off step need not recruit.
        raise HTTPException(422, (
            f'recruitment_occupation with a primary role is required for this work kind ({request.work_kind}). '
            f'Use a known work kind ({", ".join(sorted(roles))}), pass recruitment_occupation.role with an '
            'active occupation key, or give the step to an existing FLA with lead_agent_id so no one is recruited.'))
    return ProjectAgentOccupationInput(role=role)


def normalized_recruitment_profile(request):
    recruitment_occupation(request)
    position_kind = (
        'temporary'
        if request.staffing_intent == 'temporary'
        else 'durable'
    )
    profile = request.recruitment_profile or ProjectAgentProfile(
        name=f'{request.work_kind} Agent',
        responsibility=request.objective,
        agent_type=position_kind,
        work_kinds=[request.work_kind],
        capabilities=request.required_capabilities,
        status='active',
    )
    if profile.agent_type != position_kind:
        profile = profile.model_copy(update={'agent_type': position_kind})
    return position_kind, profile



def recruitment_occupation_fields(request):
    occupation = recruitment_occupation(request)
    return {
        'occupation_role': occupation.role,
        'occupation_tags': occupation.tags,
        'occupation_basis': 'explicit' if request.recruitment_occupation else
            ('default_lead' if request.staffing_intent == 'default_lead' else 'work_kind'),
    }


def stored_recruitment_occupation(raw):
    if not raw.get('occupation_role'):
        raise HTTPException(409, 'recruitment occupation migration pending; select a primary role')
    occupation = ProjectAgentOccupationInput(
        role=raw['occupation_role'], tags=raw.get('occupation_tags') or [],
    )
    if occupation.role == 'assistant':
        raise HTTPException(422, 'use the fixed global employee.assistant; assistants cannot be recruited')
    return occupation
