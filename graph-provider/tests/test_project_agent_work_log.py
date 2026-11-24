"""The work log names the workstream a task belonged to (docs/workstreams.md)."""

from fuli_graph.project_agent_work_log import workstream_id


def test_a_task_a_workstream_took_names_it():
    record = {'agent_assignment': {'match_basis': ['project_team_lead', 'workstream:standing-1 工作线「春促」由 Ember 接着做']}}
    assert workstream_id(record) == 'standing-1'
    # A turn that stayed on its line says nothing again; its marker is the ID alone.
    assert workstream_id({'agent_assignment': {'match_basis': ['workstream:standing-1']}}) == 'standing-1'


def test_any_other_task_names_none():
    assert workstream_id({'agent_assignment': {'match_basis': ['standing_assignment:standing-1 notice']}}) is None
    assert workstream_id({'agent_assignment': None}) is None
    assert workstream_id({}) is None
