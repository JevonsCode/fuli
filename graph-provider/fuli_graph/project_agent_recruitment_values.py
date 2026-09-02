"""Value conversion helpers for durable project Agent recruitment records."""

from .project_agent_models import ProjectAgentProfile
from .project_agent_task_models import ProjectAgentRecruitmentRecord
from .provider_values import native_datetime


def project_agent_recruitment_record(raw):
    proposed_profile = ProjectAgentProfile.model_validate_json(
        raw['proposed_profile_json']
    )
    occupation_emoji = raw.get('occupation_emoji') or raw.get(
        'occupationEmoji'
    )
    if not proposed_profile.occupation_emoji and occupation_emoji:
        proposed_profile = proposed_profile.model_copy(
            update={'occupation_emoji': occupation_emoji}
        )
    fields = {
        'recruitment_id': raw.get('recruitment_id') or raw['id'],
        'personal_space_id': raw['personal_space_id'],
        'personal_project_id': raw['personal_project_id'],
        'task_id': raw['task_id'],
        'coordinator_agent_id': raw['coordinator_agent_id'],
        'hr_agent_id': raw.get('hr_agent_id'),
        'position_kind': raw['position_kind'],
        'work_kind': raw['work_kind'],
        'required_capabilities': list(raw.get('required_capabilities') or []),
        'reason_code': raw['reason_code'],
        'reason': raw['reason'],
        'status': raw['status'],
        'confirmation_mode': raw['confirmation_mode'],
        'proposed_agent_id': raw['proposed_agent_id'],
        'proposed_profile': proposed_profile,
        'participant_role': raw.get('participant_role') or 'lead',
        'recruitment_slot': raw.get('recruitment_slot') or 'lead',
        'trigger_source_application': raw.get('trigger_source_application'),
        'trigger_source_session_id': raw.get('trigger_source_session_id'),
        'revision': int(raw.get('revision') or 0),
        'recruited_agent_id': raw.get('recruited_agent_id'),
        'created_at': native_datetime(raw['created_at']),
        'updated_at': native_datetime(raw['updated_at']),
        'fulfilled_at': native_datetime(raw.get('fulfilled_at')),
    }
    for name in ('test_source', 'cleanup_eligible'):
        if name in ProjectAgentRecruitmentRecord.model_fields:
            fields[name] = raw.get(name)
    return ProjectAgentRecruitmentRecord(**fields)
