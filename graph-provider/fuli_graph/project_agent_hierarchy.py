"""Project-local reporting only; it grants no data, client or execution access."""


def reporting_parent(policy, agent_id):
    lead = policy.team_lead_agent_id
    if not lead or agent_id == lead:
        return None
    for group in getattr(policy, 'sub_teams', []):
        if agent_id in group.member_agent_ids:
            return group.lead_agent_id
    # Existing bounded collaborators still coordinate through the project lead.
    return lead


def direct_reporting_link(policy, sender, receiver):
    if not policy.team_lead_agent_id or not sender or not receiver:
        return False
    if not getattr(policy, 'sub_teams', []):
        return sender == policy.team_lead_agent_id or receiver == policy.team_lead_agent_id
    return sender != receiver and (reporting_parent(policy, sender) == receiver
                                   or reporting_parent(policy, receiver) == sender)


def direct_reports(policy, coordinator):
    return [member for member in policy.team_member_agent_ids
            if reporting_parent(policy, member) == coordinator]


async def bind_task_coordinator(store, actor, request, policy):
    """A model-supplied coordinator never impersonates the current task owner.

    The local user can still maintain tasks without an Agent task token. A
    grouped member may register its own work, but only leads staff children.
    """
    if not getattr(policy, 'sub_teams', []) or not request.task_context_token:
        return request
    from fastapi import HTTPException
    context = await store.get_task_context(actor, request.personal_space_id,
                                           request.task_context_token, request.source_application)
    sender = context.get('project_agent_id')
    if not sender:
        raise HTTPException(403, 'Grouped staffing requires the actual task owner')
    source = await store.get_project_agent(actor, request.personal_space_id, request.personal_project_id, sender)
    if (source.profile.status != 'active' or request.source_application not in source.profile.allowed_clients
            or not any(assignment.status == 'active' and assignment.personal_project_id == request.personal_project_id
                       for assignment in source.assignments)):
        raise HTTPException(403, 'The task owner must have a current assignment and source client authorization')
    coordinators = {policy.team_lead_agent_id, *(group.lead_agent_id for group in policy.sub_teams)}
    if sender in coordinators:
        if request.coordinator_agent_id not in {None, sender}:
            raise HTTPException(403, 'The coordinator must be the actual task owner')
        if sender != policy.team_lead_agent_id and request.staffing_intent in {'new_durable', 'temporary'}:
            raise HTTPException(403, 'Report sub-team recruitment needs to the project lead')
        return request.model_copy(update={'coordinator_agent_id': sender})
    parent = reporting_parent(policy, sender)
    if (request.coordinator_agent_id not in {None, parent}
            or request.lead_agent_id not in {None, sender}
            or request.collaborator_agent_ids or request.parallel_plan.enabled
            or request.staffing_intent not in {'reuse_preferred', 'unassigned'}):
        raise HTTPException(403, 'Members register only their own work and report to the immediate lead')
    return request.model_copy(update={'lead_agent_id': sender, 'coordinator_agent_id': parent})


def validate_task_reports(policy, coordinator, participants):
    if not getattr(policy, 'sub_teams', []):
        return
    from fastapi import HTTPException
    if any(person['agent_id'] != coordinator and reporting_parent(policy, person['agent_id']) != coordinator
           for person in participants):
        raise HTTPException(403, 'All task participants must use their immediate reporting coordinator')


def validate_worker_reporting(raw_policy, scope, run, task, owner, agent):
    """Bind new grouped runs; current locks already serialize policy changes."""
    import json
    from datetime import UTC
    from fastapi import HTTPException
    from .project_agent_coordination_models import ProjectAgentCoordinationPolicyRecord, validate_sub_team_membership
    from .provider_values import native_datetime
    try:
        groups = json.loads(raw_policy.get('sub_teams_json') or '[]')
        if not isinstance(groups, list):
            raise ValueError('sub-teams must be a list')
        if not groups and not run.get('hierarchy_policy_version'):
            return
        policy = ProjectAgentCoordinationPolicyRecord(personal_space_id=scope.personal_space_id,
            personal_project_id=scope.personal_project_id, team_lead_agent_id=raw_policy.get('team_lead_agent_id'),
            team_member_agent_ids=raw_policy.get('team_member_agent_ids') or [], sub_teams=groups)
        validate_sub_team_membership(policy.team_lead_agent_id, policy.team_member_agent_ids, policy.sub_teams)
        version = native_datetime(raw_policy['updated_at']).astimezone(UTC).isoformat()
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(409, 'Stored worker reporting hierarchy is invalid') from error
    if not groups or (run.get('id') and run.get('hierarchy_policy_version') != version):
        raise HTTPException(409, 'Worker reporting hierarchy changed; prepare a new attempt')
    if owner != agent and (reporting_parent(policy, agent) != owner or task.get('coordinator_agent_id') != owner):
        raise HTTPException(403, 'Worker dispatch must use the immediate reporting lead')
    if not run.get('id'):
        run['hierarchy_policy_version'] = version
