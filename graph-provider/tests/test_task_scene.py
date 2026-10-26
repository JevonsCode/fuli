import json
from pathlib import Path

import pytest

from fuli_graph.preference_task_scope import preference_task_applicability
from fuli_graph.task_scene import TASK_SCENE_VERSION

# Shared with test/task-scene.test.js.
FIXTURE_PATH = Path(__file__).resolve().parents[2] / 'test-support' / 'task-scene-cases.json'
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding='utf-8'))


def applicability(qualifiers, task, instruction='Synthetic rule', aspect='taste'):
    return preference_task_applicability(qualifiers, instruction, aspect, task.get('session_id'),
                                         task.get('work_kind'), task.get('workflow'))


def test_scene_table_version_matches_the_shared_cases():
    assert TASK_SCENE_VERSION == FIXTURE['version']


@pytest.mark.parametrize('case', FIXTURE['cases'], ids=[case['name'] for case in FIXTURE['cases']])
def test_shared_cases(case):
    instruction = case.get('instruction', 'Synthetic rule')
    aspect = case.get('aspect', 'taste')
    actual = applicability(case['qualifiers'], case['task'], instruction, aspect)
    assert actual == case['expected']


def test_every_taste_domain_row_and_domains_outside_the_table():
    for domain, scenes in FIXTURE['taste_domains'].items():
        for work_kind in FIXTURE['work_kinds']:
            expected = 'applies' if scenes == '*' or work_kind in scenes else 'excluded'
            actual = applicability({'tasteDomain': domain}, {'work_kind': work_kind})
            assert actual == expected, (domain, work_kind)
