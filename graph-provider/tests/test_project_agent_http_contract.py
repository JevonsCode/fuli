import os


os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


def test_super_collaboration_http_contract_exposes_all_control_plane_layers():
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    paths = application.openapi()['paths']
    expected = {
        '/v1/project-agents': {'get', 'put'},
        '/v1/project-agent-assignments': {'get', 'post'},
        '/v1/project-agent-tasks': {'get', 'post'},
        '/v1/project-agent-coordination-policy': {'get', 'put'},
        '/v1/project-agent-recruitments': {'get'},
        '/v1/executors': {'get', 'put'},
        '/v1/executors/authorization': {'post'},
        '/v1/executors/preflight': {'post'},
        '/v1/executors/health': {'post'},
        '/v1/executor-routing-rules': {'get', 'put'},
        '/v1/executor-routing-rules/{rule_id}': {'get', 'patch', 'delete'},
        '/v1/project-agent-routing-learning': {'get'},
    }

    for path, methods in expected.items():
        assert methods <= set(paths[path])
