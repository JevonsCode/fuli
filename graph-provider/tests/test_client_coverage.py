"""rec#11 D-64: a client list stored before OpenCode had its own source keeps covering it."""

from fuli_graph.client_coverage import covers_client
from fuli_graph.project_agent_models import ProjectAgentProfile
from fuli_graph.store_project_agent_task_staffing import StoreProjectAgentTaskStaffing


def test_a_list_naming_other_covers_opencode_until_it_names_opencode_itself():
    assert covers_client(['codex', 'other'], 'opencode')
    assert covers_client(['codex', 'opencode'], 'opencode')
    assert not covers_client(['codex', 'claude_code'], 'opencode')
    assert not covers_client([], 'opencode')
    assert not covers_client(None, 'opencode')


def test_a_list_naming_other_covers_antigravity_by_the_same_rule():
    hired_before = ['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode', 'other']
    assert covers_client(hired_before, 'antigravity')
    assert covers_client(['antigravity'], 'antigravity')
    assert not covers_client(['codex'], 'antigravity')
    assert not covers_client(['antigravity'], 'other')


def test_an_existing_lead_serves_antigravity_so_its_tasks_keep_their_owner():
    # Hired with the default client list before Antigravity had its own source.
    profile = ProjectAgentProfile(name='Synthetic lead', responsibility='Synthetic work',
                                  allowed_clients=['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode', 'other'])
    assert StoreProjectAgentTaskStaffing._agent_client_allowed({'profile': profile}, 'antigravity')
    assert 'antigravity' not in profile.allowed_clients


def test_the_alias_widens_nothing_else():
    assert covers_client(['other'], 'other')
    assert not covers_client(['other'], 'codex')
    assert not covers_client(['opencode'], 'other')


def test_an_existing_agent_that_allowed_other_serves_opencode_without_a_stored_change():
    # Saved before D-64: the person allowed `other` for OpenCode, and the profile is never rewritten.
    profile = ProjectAgentProfile(name='Synthetic lead', responsibility='Synthetic work',
                                  allowed_clients=['codex', 'other'])
    assert StoreProjectAgentTaskStaffing._agent_client_allowed({'profile': profile}, 'opencode')
    assert profile.allowed_clients == ['codex', 'other']
    narrowed = ProjectAgentProfile(name='Synthetic lead', responsibility='Synthetic work', allowed_clients=['codex'])
    assert not StoreProjectAgentTaskStaffing._agent_client_allowed({'profile': narrowed}, 'opencode')
