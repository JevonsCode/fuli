"""Which records a first copy of `global` takes over (global_replica.is_system_default)."""
from fuli_graph.fixed_roles import SYSTEM_ROLE_AGENT_IDS
from fuli_graph.global_replica import is_system_default
from fuli_graph.provider_values import stable_uuid

SPACE, PROVIDER = '0f0e0d0c-0b0a-4909-8807-060504030201', 'local-personal'


def role(agent_id, **changes):
    return {'id': stable_uuid(PROVIDER, SPACE, 'project-agent', agent_id), 'agent_id': agent_id,
            'system_managed': True, **changes}


def test_only_the_providers_own_defaults_under_the_ids_it_derives():
    for agent_id in SYSTEM_ROLE_AGENT_IDS:
        assert is_system_default('FuliProjectAgent', role(agent_id), SPACE, PROVIDER)
    assert is_system_default('FuliProjectAgentRecruitmentPolicy', {'personal_space_id': SPACE}, SPACE, PROVIDER)
    # An FLA the person hired: created with system_managed false, under its own agent_id.
    hired = {'id': stable_uuid(PROVIDER, SPACE, 'project-agent', 'synthetic-writer'), 'agent_id': 'synthetic-writer',
             'system_managed': False}
    assert not is_system_default('FuliProjectAgent', hired, SPACE, PROVIDER)
    assert not is_system_default('FuliProjectAgent', {**hired, 'system_managed': True}, SPACE, PROVIDER)
    # A fixed role not (yet) made by the Provider itself, or under an ID another space or Provider derives.
    jefa = SYSTEM_ROLE_AGENT_IDS[0]
    assert not is_system_default('FuliProjectAgent', role(jefa, system_managed=False), SPACE, PROVIDER)
    assert not is_system_default('FuliProjectAgent', role(jefa), SPACE, 'another-provider')
    assert not is_system_default('FuliProjectAgent', role(jefa, id='synthetic-id'), SPACE, PROVIDER)
    assert not is_system_default('FuliProjectAgentRecruitmentPolicy', {'personal_space_id': 'other'}, SPACE, PROVIDER)
    # Any other record, whatever it holds.
    assert not is_system_default('FuliOccupation', role(jefa), SPACE, PROVIDER)
    assert not is_system_default('Entity', {'system_managed': True}, SPACE, PROVIDER)
