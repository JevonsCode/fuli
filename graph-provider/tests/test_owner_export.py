from copy import deepcopy

import pytest
from fastapi import HTTPException

from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION
from fuli_graph.provider_values import stable_uuid
from fuli_graph.scope_export import envelope_digest
from fuli_graph.scope_import import verify_owner_export


def project_export():
    root = stable_uuid('local', 'sample', 'personal-project', 'one')
    return {'spaceId': 'sample', 'scope': 'project:one', 'groupId': 'synthetic', 'vectors': False,
            'embeddingModel': None, 'replicaProtocol': 1, 'graphFormat': GRAPH_FORMAT_VERSION,
            'complete': True, 'relationships': [], 'externalRefs': [], 'nodes': [{
                'id': 'FuliPersonalProject:' + root, 'labels': ['FuliPersonalProject'], 'scopes': ['project:one'],
                'properties': {'id': root, 'project_id': 'one'}}]}


def test_project_owner_proof_binds_the_root_identity_space_and_complete_image():
    original = project_export()
    original['digest'] = envelope_digest(original)
    assert verify_owner_export(original, 'sample', 'one', 'local')['digest'] == original['digest']
    for change in ('format', 'space', 'root', 'marker', 'complete', 'digest', 'duplicate'):
        data = deepcopy(original)
        if change == 'format':
            data['graphFormat'] += 1
        elif change == 'space':
            data['spaceId'] = 'another'
        elif change == 'root':
            data['nodes'][0]['properties']['id'] = 'different'
        elif change == 'marker':
            data['nodes'][0]['properties']['fuli_replica_owner'] = 'a' * 64
        elif change == 'complete':
            data['complete'] = False
        elif change == 'duplicate':
            data['nodes'].append(deepcopy(data['nodes'][0]))
        data['digest'] = 'e' * 64 if change == 'digest' else envelope_digest(data)
        with pytest.raises(HTTPException):
            verify_owner_export(data, 'sample', 'one', 'local')
