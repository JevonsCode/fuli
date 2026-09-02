from fuli_graph.task_context_models import TaskContextBegin


def test_task_context_begin_preserves_bounded_host_session_provenance():
    value = TaskContextBegin.model_validate({
        'personal_space_id': 'space-1',
        'personal_project_id': 'project-1',
        'project_agent_id': 'agent-1',
        'session_id': 'logical-session',
        'source_application': 'claude_code',
        'source_session_id': 'mcp-host-session',
        'token': 'fuli-task-12345678',
        'turn_id': 'turn-1',
    })

    assert value.source_session_id == 'mcp-host-session'
    assert value.model_dump(mode='json')['source_session_id'] == 'mcp-host-session'
