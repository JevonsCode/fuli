from fastapi import HTTPException
import pytest

from fuli_graph.scope_classifier import GraphNode, ScopeClassification
from fuli_graph.scope_export import SpaceRead, node_id
from fuli_graph.scope_handover import external_bindings


def test_external_reference_refusals_identify_the_record_and_cross_project_scope():
    nodes = {element: GraphNode(element, 'Entity', ('Entity',), {'uuid': 'shared-id'})
             for element in ('first', 'second')}
    read = SpaceRead(ScopeClassification('space-root', nodes, [], {}), {}, set())
    key = node_id(nodes['first'])
    for scope, code in [('project:other', 'project_move_cross_project_reference'),
                        ('global', 'project_move_ambiguous_reference')]:
        with pytest.raises(HTTPException) as caught:
            external_bindings(read, {'externalRefs': [{'id': key, 'scope': scope}]}, 'space')
        expected = {'code': code, 'record': key}
        if scope != 'global':
            expected['scopes'] = [scope]
        assert caught.value.detail == expected
