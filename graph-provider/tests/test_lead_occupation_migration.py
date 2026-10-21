"""Offline migration planning uses synthetic snapshots only."""
import importlib

import pytest


def migration():
    return importlib.import_module('fuli_graph.migrate_lead_occupation')


def test_migration_preview_requires_exact_projects_and_preserves_identity_memory():
    module = migration()
    rows = [dict(project_id=f'project-{i}', agent_id=f'lead-{i}', role='engineering', tags=['testing']) for i in range(3)]
    plan = module.build_plan('space', ['project-0', 'project-1', 'project-2'], rows)
    assert len(plan['changes']) == 3
    assert all(change['after'] == {'role': 'lead', 'tags': ['testing']} for change in plan['changes'])
    assert all(set(change) == {'agent_id', 'project_ids', 'before', 'after'} for change in plan['changes'])
    assert plan == module.build_plan('space', ['project-2', 'project-0', 'project-1'], rows)
    with pytest.raises(ValueError, match='missing'):
        module.build_plan('space', ['project-0', 'absent'], rows)


def test_migration_deduplicates_shared_leads_and_is_idempotent():
    module = migration()
    rows = [dict(project_id=p, agent_id='shared', role=None, tags=[]) for p in ['a', 'b']]
    plan = module.build_plan('space', ['a', 'b'], rows)
    assert len(plan['changes']) == 1
    assert plan['changes'][0]['project_ids'] == ['a', 'b']
    assert module.build_plan('space', ['a'], [dict(project_id='a', agent_id='done', role='lead', tags=[])])['changes'] == []


def test_migration_does_not_reclassify_builtin_as_project_lead():
    with pytest.raises(ValueError, match='builtin'):
        migration().build_plan('space', ['a'], [dict(project_id='a', agent_id='employee.assistant', role='assistant', tags=[])])


class Result(list):
    def consume(self):
        return None


class Transaction:
    def __init__(self, rows, format_version=None):
        from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION

        self.rows = rows
        self.format_version = GRAPH_FORMAT_VERSION if format_version is None else format_version
        self.calls = []

    def run(self, query, **parameters):
        self.calls.append((query, parameters))
        if query == migration().SNAPSHOT:
            return Result(self.rows)
        if 'FuliDataFormat' in query:
            return Result([{'version': self.format_version}])
        return Result()


def test_preview_never_writes_and_apply_requires_fresh_digest():
    module = migration()
    rows = [dict(project_id='a', agent_id='lead', role='engineering', tags=[])]
    preview_tx = Transaction(rows)
    plan = module.migrate(preview_tx, 'space', ['a'])
    assert len(preview_tx.calls) == 1
    assert preview_tx.calls[0][0] == module.SNAPSHOT
    stale_tx = Transaction(rows)
    with pytest.raises(ValueError, match='stale'):
        module.migrate(stale_tx, 'space', ['a'], expected_digest='stale')
    assert not any('CREATE (audit' in query for query, _ in stale_tx.calls)
    applied_tx = Transaction(rows)
    applied = module.migrate(applied_tx, 'space', ['a'], expected_digest=plan['digest'])
    assert applied['status'] == 'applied'
    query, parameters = applied_tx.calls[-1]
    assert 'CHANGED_OCCUPATION' in query
    assert parameters['changes'] == plan['changes']
    assert all(term not in query for term in ['profile_json', 'memory_json', 'DELETE'])


def test_migration_requires_all_assignments_of_a_shared_lead_to_be_explicit():
    with pytest.raises(ValueError, match='outside'):
        migration().build_plan('space', ['a'], [dict(project_id='a', agent_id='lead',
            role='engineering', tags=[], active_project_ids=['a', 'b'])])


def test_apply_refuses_a_graph_not_at_this_data_format():
    module = migration()
    rows = [dict(project_id='a', agent_id='lead', role='engineering', tags=[])]
    plan = module.migrate(Transaction(rows), 'space', ['a'])
    newer = Transaction(rows, format_version=999)
    with pytest.raises(ValueError, match='data format is 999'):
        module.migrate(newer, 'space', ['a'], expected_digest=plan['digest'])
    assert not any('CHANGED_OCCUPATION' in query for query, _ in newer.calls)
