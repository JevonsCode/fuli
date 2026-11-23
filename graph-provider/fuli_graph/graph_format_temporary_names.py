"""graph/23: a temporary project stores no name.

FULI used to write one of its own names into every temporary project it
opened — 「临时任务 / Temporary task」, 「临时会话 / Temporary session」, and
「会话项目 / Conversation project」 for the conversation fallback task entry
created until 2026-10-18. The name said nothing about which project it was,
and it was stored in one language, so a console in another language still
showed Chinese.

Temporary projects now store no name at all (temporary_project_scope.py) and
every reader shows them in the person's own language, told apart by their
short number, their date and whatever title someone later gave them. This step
clears the three names FULI generated, and only those: a temporary project a
person renamed keeps the name they gave it, and nothing else on any record
changes. Both places the name lives are cleared, the `name` column and the
`name` inside `profile_json`, so no reader can fall back to the other.
"""

import json

from .graph_format_journal import RecordJournal, RecordTouch

# Every name FULI ever generated for a temporary project. Nothing is matched by
# shape: a name a person happens to have typed that is not on this list stays.
GENERATED_NAMES = (
    '临时任务 / Temporary task',
    '临时会话 / Temporary session',
    '会话项目 / Conversation project',
)


def _literal(text: str) -> str:
    # The journal runs a touch's match without parameters, so the generated
    # names are written into it; they are the constants above, never input.
    if "'" in text or '\\' in text:
        raise ValueError('a generated name must not need escaping')
    return f"'{text}'"


# A temporary project by where it came from, never by its name: the scope_type
# the provider sets, or the conversation fallback's generated ID. The name test
# then decides whether FULI wrote that name or a person did.
_GENERATED_TEMPORARY_NAME = (
    'MATCH (item:FuliPersonalProject) '
    "WHERE (item.scope_type = 'temporary' OR item.project_id STARTS WITH 'conversation-') "
    'AND item.name IN [' + ', '.join(_literal(name) for name in GENERATED_NAMES) + '] '
)


async def pending_temporary_names(driver, _settings) -> list[str]:
    """Temporary projects still holding a name FULI generated."""
    records, _, _ = await driver.execute_query(
        _GENERATED_TEMPORARY_NAME + 'RETURN item.id AS key', routing_='r')
    return sorted(str(record['key']) for record in records)


async def apply_temporary_names(driver, _settings, *, apply_id=None) -> None:
    records, _, _ = await driver.execute_query(
        _GENERATED_TEMPORARY_NAME + 'RETURN item.id AS id, item.profile_json AS profile_json')
    rows = [{'id': str(record['id']), 'profile_json': _without_name(record['profile_json'])}
            for record in records]
    if not rows:
        return
    await driver.execute_query(
        '''
        UNWIND $rows AS row
        MATCH (item:FuliPersonalProject {id: row.id})
        SET item.name = '', item.profile_json = row.profile_json
        ''', rows=rows)


def _without_name(profile_json) -> str:
    """The same profile with an empty name. Every other field is written back
    exactly as it was read, in the order it was stored."""
    profile = json.loads(profile_json) if profile_json else {}
    profile['name'] = ''
    return json.dumps(profile, ensure_ascii=False)


TEMPORARY_NAME_JOURNAL = RecordJournal(touches=(
    RecordTouch('node', _GENERATED_TEMPORARY_NAME, ('name', 'profile_json')),
))
