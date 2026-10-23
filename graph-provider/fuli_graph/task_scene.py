"""Which preferences a task scene selects (rec#15 D-27).

The Provider's copy of src/graphiti/task-scene.js: the same versioned
tasteDomain table and general rule, checked against the shared cases in
test-support/task-scene-cases.json. A change to either copy needs the next
TASK_SCENE_VERSION in both.
"""

TASK_SCENE_VERSION = 'task-scene-1'
EVERY_SCENE = '*'
_CHAT = 'chat'

TASTE_DOMAIN_SCENES = {
    'frontend': ('frontend',),
    'ui': ('design', 'frontend'),
    'ux': ('design', 'frontend'),
    'design': ('design', 'frontend'),
    'visual': ('design', 'frontend'),
    'architecture': ('architecture',),
    'code': ('implementation', 'code_review', 'frontend', 'test_validation'),
    'testing': ('test_validation',),
    'chat': (_CHAT,),
    # Every reply is writing, chat included.
    'writing': EVERY_SCENE,
}


def taste_domain_scenes(qualifiers: dict):
    """None when no tasteDomain is stated, EVERY_SCENE, or a list of work kinds
    ([] when no listed domain is in the table: it matches no scene)."""
    value = qualifiers.get('tasteDomain')
    if value is None:
        value = qualifiers.get('taste_domain')
    if value is None or value == '':
        return None
    if isinstance(value, str):
        domains = [value]
    elif isinstance(value, list) and all(isinstance(item, str) for item in value):
        domains = value
    else:
        domains = []
    scenes = [TASTE_DOMAIN_SCENES.get(domain.strip().lower(), ()) for domain in domains]
    if EVERY_SCENE in scenes:
        return EVERY_SCENE
    return list(dict.fromkeys(kind for kinds in scenes for kind in kinds))


def general_item_excluded(qualifiers: dict, work_kind) -> bool:
    """An item with no scene key is dropped only in a positively chat task; a
    user's hard constraint (constraint: "hard") never is."""
    return work_kind == _CHAT and qualifiers.get('constraint') != 'hard'
