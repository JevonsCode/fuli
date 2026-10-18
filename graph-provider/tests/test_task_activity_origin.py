from datetime import UTC, datetime
import json
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks


ORIGIN = {'version': 1, 'kind': 'ai_internal', 'source': 'sealed_worker', 'purpose': 'test'}


def task_row(**changes):
    raw = {'task_id': 'origin-task', 'personal_space_id': 'origin-space',
           'personal_project_id': 'origin-project', 'title': 'Synthetic test',
           'objective': 'Check source metadata', 'work_kind': 'test_validation',
           'coordinator_agent_id': 'origin-lead', 'status': 'queued',
           'created_at': datetime.now(UTC), 'updated_at': datetime.now(UTC)}
    raw.update(changes)
    return {'task': raw, 'event_rows': [], 'participant_rows': []}


def test_task_read_model_preserves_durable_origin_and_leaves_legacy_unknown():
    store = StoreProjectAgentTasks()
    task = store._task_from_row(task_row(activity_origin_json=json.dumps(ORIGIN)))
    assert task.model_dump().get('activity_origin') == ORIGIN
    assert store._task_from_row(task_row()).model_dump().get('activity_origin') is None
