"""The write guard on read-only copies (replica_write_guard.py), in memory: what
it compares, that a graph without copies reads nothing for it, and that only
the import passes it. The same on a real Neo4j: test_replica_write_guard_neo4j.py."""
import ast
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph import replica_write_guard as guard_module
from fuli_graph.replica_write_guard import (
    ReplicaWriteGuard, refuse_global_write, refuse_if_copy,
)
from test_graph_field_contract import PACKAGE

OWNER = 'a' * 64


class Rows:
    def __init__(self, rows):
        self._rows = rows

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for row in self._rows:
            yield row


class Graph:
    """Answers the guard's queries from a dict of copied nodes and relationships."""

    def __init__(self):
        self.nodes = {'n1': (['Entity'], {'uuid': 'habit', 'name': 'Synthetic habit', 'fuli_replica_owner': OWNER,
                                          'fuli_replica_scopes': ['global']})}
        self.relationships = {'r1': ('MENTIONS', {'uuid': 'mention', 'fuli_replica_owner': OWNER})}
        self.links = 0
        self.counts = {label: 1 for label in guard_module.GLOBAL_LABELS} | {'Entity': 1}
        self.queries = 0

    async def run(self, query, derived=(), ids=None):
        self.queries += 1

        def pairs(properties):
            return [[key, value] for key, value in properties.items() if key not in derived]
        if query == guard_module._COPIED_NODES:
            return Rows([{'id': key, 'labels': labels, 'properties': pairs(properties)}
                         for key, (labels, properties) in self.nodes.items()])
        if query == guard_module._COPIED_RELATIONSHIPS:
            return Rows([{'id': key, 'type': kind, 'properties': pairs(properties)}
                         for key, (kind, properties) in self.relationships.items()])
        if query == guard_module._NODES_NOW:
            return Rows([{'id': key, 'labels': self.nodes[key][0] if key in self.nodes else None,
                          'properties': pairs(self.nodes[key][1]) if key in self.nodes else None} for key in ids])
        if query == guard_module._RELATIONSHIPS_NOW:
            return Rows([{'id': key, 'type': self.relationships.get(key, (None,))[0],
                          'properties': pairs(self.relationships[key][1]) if key in self.relationships else None}
                         for key in ids])
        if query == guard_module._LOCAL_LINKS:
            return Rows([{'links': self.links}])
        if query == guard_module._COUNTS:
            return Rows([dict(self.counts)])
        raise AssertionError(query)


async def guarded(graph, *, global_replica=True):
    guard = ReplicaWriteGuard(global_replica)
    await guard.refresh(graph)
    return guard


async def refused(guard, graph):
    with pytest.raises(HTTPException) as caught:
        await guard.check(graph)
    assert caught.value.status_code == 409
    return caught.value.detail


@pytest.mark.asyncio
async def test_a_graph_without_copies_reads_nothing_for_the_guard():
    graph = Graph()
    guard = ReplicaWriteGuard(global_replica=False)
    await guard.check(graph)
    assert graph.queries == 0
    assert guard.status() == {'holdsCopies': None, 'checks': 'unknown'}
    await guard.refresh_empty(graph)
    assert guard.status() == {'holdsCopies': False, 'checks': 'none'}
    assert graph.queries == 0


@pytest.fixture
def every_write(monkeypatch):
    monkeypatch.setattr(guard_module, 'CHECK_EVERY_WRITE', True)


@pytest.mark.asyncio
async def test_writes_are_checked_at_run_time_only_where_the_measured_cost_allows():
    graph = Graph()
    guard = await guarded(graph)
    graph.nodes['n1'][1]['name'] = 'Changed here'
    await guard.check(graph)  # CHECK_EVERY_WRITE is off: the periodic import puts it back
    assert guard.status() == {'holdsCopies': True, 'copiedRecords': 2, 'checks': 'periodic_import'}


@pytest.mark.asyncio
async def test_an_unchanged_copy_passes_and_a_derived_property_may_change(every_write):
    graph = Graph()
    guard = await guarded(graph)
    await guard.check(graph)
    graph.nodes['n1'][1]['fuli_semantic_vector'] = [0.5, 0.25]
    graph.nodes['n1'][1]['name_embedding'] = [0.0, 1.0]
    await guard.check(graph)
    assert guard.status() == {'holdsCopies': True, 'copiedRecords': 2, 'checks': 'every_write'}


@pytest.mark.asyncio
async def test_a_changed_or_removed_copy_is_refused_with_its_record_and_owner(every_write):
    graph = Graph()
    guard = await guarded(graph)
    graph.nodes['n1'][1]['name'] = 'Changed here'
    detail = await refused(guard, graph)
    assert (detail['code'], detail['record'], detail['owner'], detail['scopes']) == (
        'replica_read_only', 'Entity:habit', OWNER, ['global'])
    graph.nodes['n1'][1]['name'] = 'Synthetic habit'
    graph.nodes['n1'][0].append('Extra')
    await refused(guard, graph)
    graph.nodes['n1'][0].remove('Extra')
    del graph.relationships['r1']
    assert (await refused(guard, graph))['record'] == 'MENTIONS'


@pytest.mark.asyncio
async def test_a_new_record_of_global_or_a_local_link_between_copies_is_refused(every_write):
    graph = Graph()
    guard = await guarded(graph)
    graph.counts['FuliProjectAgent'] += 1
    assert 'FuliProjectAgent' in (await refused(guard, graph))['record']
    graph.counts['FuliProjectAgent'] -= 1
    graph.counts['Entity'] += 1
    await refused(guard, graph)
    graph.counts['Entity'] -= 1
    graph.links += 1
    await refused(guard, graph)


@pytest.mark.asyncio
async def test_above_the_limit_writes_are_not_checked_and_the_status_says_so(monkeypatch, every_write):
    graph = Graph()
    guard = await guarded(graph)
    monkeypatch.setattr(guard_module, 'MAX_GUARDED_RECORDS', 1)
    graph.nodes['n1'][1]['name'] = 'Changed here'
    await guard.check(graph)
    assert guard.status()['checks'] == 'too_large'
    monkeypatch.setattr(guard_module, 'STRICT', True)
    await refused(guard, graph)


def test_entry_refusals_name_the_owner():
    refuse_if_copy({'name': 'own'}, 'Entity:own')
    refuse_if_copy(None, 'Entity:gone')
    with pytest.raises(HTTPException) as caught:
        refuse_if_copy({'fuli_replica_owner': OWNER, 'fuli_replica_scopes': ['global']}, 'Entity:habit')
    assert caught.value.detail['owner'] == OWNER
    store = SimpleNamespace(settings=SimpleNamespace(global_replica=False),
                            runtime=SimpleNamespace(driver=SimpleNamespace(replica_guard=ReplicaWriteGuard(False))))
    refuse_global_write(store, 'an FLA of the roster')
    store.settings.global_replica = True
    with pytest.raises(HTTPException) as caught:
        refuse_global_write(store, 'an FLA of the roster')
    assert caught.value.detail['code'] == 'replica_read_only'


def test_only_the_import_writes_past_the_guard():
    """The exemption is a driver method only the import and the release of copies
    (scope_import.py, scope_release.py) call: no other
    module can borrow it, nor run a write without the guard's check."""
    callers, unchecked = set(), set()
    for path in sorted(PACKAGE.glob('*.py')):
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            if isinstance(node, ast.Attribute) and node.attr == 'replica_import_transaction':
                callers.add(path.name)
            if isinstance(node, ast.keyword) and node.arg == 'copies_checked':
                unchecked.add(path.name)
    assert callers == {'scope_import.py', 'scope_release.py'}
    assert unchecked == {'runtime.py'}

@pytest.mark.asyncio
async def test_project_copies_allow_the_host_to_add_global_records(every_write):
    graph = Graph()
    guard = await guarded(graph, global_replica=False)
    graph.counts['FuliProjectAgent'] += 1
    await guard.check(graph)
    assert guard.status()['owners'] == [OWNER]


@pytest.mark.asyncio
async def test_observation_counts_only_completed_checks_and_omits_record_details(monkeypatch):
    graph = Graph()
    guard = ReplicaWriteGuard(global_replica=False, observe=True)
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def reading():
        yield graph

    async def observe():
        await guard.observe_commit(await guard.check(graph), reading)

    await observe()
    graph.nodes['n1'][1]['fuli_replica_scopes'] = ['project:sample']
    await guard.refresh(graph)
    async with guard.held_for_import():
        await observe()
    await observe()
    graph.nodes['n1'][1]['name'] = 'Synthetic update'
    await observe()
    monkeypatch.setattr(guard_module, 'MAX_GUARDED_RECORDS', 1)
    await observe()
    stats = guard.status()['observation']
    assert stats['checked'] == 2 and stats['changedByScope'] == {'project': 1}
    assert stats['skipped'] == {'inventory_unknown': 1, 'import_in_progress': 1, 'too_large': 1}
    assert stats['totalMs'] >= stats['maxMs'] >= 0
    assert 'sample' not in str(stats) and 'Synthetic' not in str(stats)


@pytest.mark.asyncio
async def test_failed_diagnostic_is_counted_without_changing_the_write_outcome():
    from contextlib import asynccontextmanager

    graph = Graph()
    guard = ReplicaWriteGuard(False, observe=True)
    await guard.refresh(graph)

    class BrokenRead:
        async def run(self, query, **parameters):
            assert query == guard_module._NODES_NOW
            raise RuntimeError('Synthetic diagnostic failure')

    @asynccontextmanager
    async def reading():
        yield BrokenRead()

    ticket = await guard.check(graph)
    await guard.observe_commit(ticket, reading)
    assert guard.status()['observation']['skipped'] == {'check_failed': 1}
    assert guard.status()['observation']['checked'] == 0
