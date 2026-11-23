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
clears the three names FULI generated, and only those: a project a person
renamed keeps the name they gave it. Both places the name lives are cleared,
the `name` column and the `name` inside `profile_json`, so no reader can fall
back to the other.

A project is recognised by its generated name alone, never by how it was
stored: the conversation fallback created its projects through the ordinary
project upsert, so they were saved as `registered`. A project holding one of
these names was opened by FULI and never named by anyone, so this step also
marks it `temporary`: it is then grouped, offered and protected as one (no
knowledge is moved into it, it adds nothing to project relations). Nothing
else on any record changes.

A project whose stored profile is not a JSON object (broken JSON, "null", a
list) cannot be rewritten safely: the step leaves it as it is and says how
many it left, so one broken record never keeps the graph read-only.

Undoing the step puts back what its journal holds, and then gives every other
project without a name the name graph/22 would have written for it
(`name_for_graph_22`): a temporary project opened after the step, or one
whose name someone cleared, is not in the journal, and a FULI on graph/22
refuses a project profile without a name, so without this its project list
would not read at all.
"""

import json

from .graph_format_journal import RecordJournal, RecordTouch
# Every name FULI ever generated, matched exactly: a name a person happens to
# have typed that is not on this list stays.
from .temporary_project_scope import GENERATED_NAMES, _SESSION_PROFILE

_TASK_NAME, _SESSION_NAME, _CONVERSATION_NAME = GENERATED_NAMES



def _literal(text: str) -> str:
    # The journal runs a touch's match without parameters, so the generated
    # names are written into it; they are the constants above, never input.
    if "'" in text or '\\' in text:
        raise ValueError('a generated name must not need escaping')
    return f"'{text}'"


# Every project still holding a name FULI generated, whatever its scope_type:
# exactly these names, so a name a person typed is never matched by shape.
_GENERATED_TEMPORARY_NAME = (
    'MATCH (item:FuliPersonalProject) '
    'WHERE item.name IN [' + ', '.join(_literal(name) for name in GENERATED_NAMES) + '] '
)


async def _generated(driver, **options) -> tuple[list[dict], int]:
    """The projects whose name FULI generated in both places it is stored: the
    `name` column matched above, and the profile's own name, which is generated
    too or missing. One whose profile carries a person's name is left alone.
    Also how many matched by their column but hold a profile that is not a
    JSON object: those are left as they are."""
    records, _, _ = await driver.execute_query(
        _GENERATED_TEMPORARY_NAME + 'RETURN item.id AS id, item.profile_json AS profile_json', **options)
    profiles = [(record, _stored_profile(record['profile_json'])) for record in records]
    generated = [record for record, profile in profiles
                 if profile is not None and _name_in(profile) in ('', *GENERATED_NAMES)]
    return generated, sum(1 for _, profile in profiles if profile is None)


async def pending_temporary_names(driver, _settings) -> list[str]:
    """Projects still holding a name FULI generated."""
    generated, _ = await _generated(driver, routing_='r')
    return sorted(str(record['id']) for record in generated)


async def apply_temporary_names(driver, _settings, *, apply_id=None) -> dict:
    """Returns how many projects it left because their profile is unreadable."""
    generated, unreadable = await _generated(driver)
    rows = [{'id': str(record['id']), 'profile_json': _with_name(record['profile_json'], '')}
            for record in generated]
    if rows:
        await driver.execute_query(
            '''
            UNWIND $rows AS row
            MATCH (item:FuliPersonalProject {id: row.id})
            SET item.name = '', item.profile_json = row.profile_json, item.scope_type = 'temporary'
            ''', rows=rows)
    return {'unreadable': unreadable}


async def name_for_graph_22(driver) -> int:
    """After an undo: every project still without a name gets the one graph/22
    would have written, in both places, and the count is returned. A profile
    that names it already lends the column its name; a project whose profile
    is not a JSON object is left, as graph/22 could not read it either."""
    records, _, _ = await driver.execute_query(
        '''
        MATCH (item:FuliPersonalProject)
        RETURN item.id AS id, item.project_id AS project_id, item.name AS name, item.profile_json AS profile_json
        ''')
    rows = []
    for record in records:
        profile = _stored_profile(record['profile_json'])
        if profile is None:
            continue
        stored, column = _name_in(profile), str(record['name'] or '').strip()
        if stored and column:
            continue
        name = stored or column or _graph_22_name(str(record['project_id'] or ''), profile)
        rows.append({'id': str(record['id']), 'name': name, 'profile_json': _with_name(record['profile_json'], name)})
    if rows:
        await driver.execute_query(
            '''
            UNWIND $rows AS row
            MATCH (item:FuliPersonalProject {id: row.id})
            SET item.name = row.name, item.profile_json = row.profile_json
            ''', rows=rows)
    return len(rows)


def _graph_22_name(project_id: str, profile: dict) -> str:
    """The name graph/22 wrote when it opened this project: the conversation
    fallback's, the session scope's (told by the purpose graph/22 gave it too),
    or the task scope's."""
    if project_id.startswith('conversation-'):
        return _CONVERSATION_NAME
    if profile.get('purpose') == _SESSION_PROFILE.purpose:
        return _SESSION_NAME
    return _TASK_NAME


def _stored_profile(profile_json) -> dict | None:
    """The stored profile, {} where there is none, None where it is not a JSON object."""
    if not profile_json:
        return {}
    try:
        profile = json.loads(profile_json)
    except (TypeError, ValueError):
        return None
    return profile if isinstance(profile, dict) else None


def _name_in(profile: dict) -> str:
    return str(profile.get('name') or '').strip()


def _with_name(profile_json, name: str) -> str:
    """The same profile with this name. Every other field is written back
    exactly as it was read, in the order it was stored."""
    profile = _stored_profile(profile_json) or {}
    profile['name'] = name
    return json.dumps(profile, ensure_ascii=False)


TEMPORARY_NAME_JOURNAL = RecordJournal(touches=(
    RecordTouch('node', _GENERATED_TEMPORARY_NAME, ('name', 'profile_json', 'scope_type')),
))
