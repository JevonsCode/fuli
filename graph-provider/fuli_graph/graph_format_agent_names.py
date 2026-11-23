"""graph/23: no two Agents of a personal space are called by the same name.

Before FULI stored a nickname for every Agent (0.20), an Agent's shown name
was derived from its ID, so Agents hired before then can share one; a name
checked before a write could also race another write. One name then reaches
several FLAs and `#FLA <name>` has to ask. This step gives every Agent but one
of each shared name a new generated name, and graph/24 then makes the graph
itself refuse a second Agent with a name (store_project_agent_naming.py).

Who keeps the name, in order: a built-in role (a role still answers to its
built-in name after a rename, so that name counts as its too); an Agent not
dismissed; one that is not a test Agent; one whose name a person gave it in a
rename; the one with more work (tasks it took part in and task entries it
worked: each is one turn of a conversation with its work log); the one active
most recently; the one hired first. The others record the old name in their
name history with who kept it and on which of these rules they gave way
(project_agent_name_history.py), so pages and receipts can say 「原名 …」 and
the console lists every rename in one place. Only the shown name and its
history change: agent_id, assignments, memory, conversations and everything
already said or signed under the old name stay as they are.

Changing names a person may have confirmed is a record step: like every
record step it waits for the person's one confirmation for all Agents at once
(graph_format_confirm.py), and its journal can undo it.
"""
from datetime import datetime
import json
import re

from .graph_format_journal import RecordJournal, RecordTouch
from .name_identity import identity_key
from .project_agent_models import ProjectAgentNameChange
from .project_agent_name_history import name_history, with_former_name
from .project_agent_names import agent_display_name, free_nicknames
from .provider_values import now_utc
from .store_project_agent_naming import SYSTEM_NAMED
from .system_agents import SYSTEM_PROFILES

_AGENTS = '''
MATCH (space:FuliSpace {kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->(item:FuliProjectAgent)
WHERE item.display_name_key IS NULL
'''

_READ = _AGENTS + '''
OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask)-[:HAS_PARTICIPANT]->(item)
WITH space, item, count(DISTINCT task) AS tasks
OPTIONAL MATCH (space)-[:HAS_TASK_CONTEXT_SESSION]->(:FuliTaskContextSession)-[:HAS_CONTEXT]->
      (turn:FuliTaskContext {project_agent_id: item.agent_id})
WITH space, item, tasks, count(DISTINCT turn) AS turns, max(toString(turn.created_at)) AS last_turn
RETURN space.id AS space_id, item.agent_id AS agent_id, item.profile_json AS profile_json, item.name AS name,
       item.name_history_json AS name_history_json, item.status AS status,
       item.test_source AS test_source, item.cleanup_eligible AS cleanup_eligible,
       toString(item.created_at) AS created_at, toString(item.updated_at) AS updated_at,
       tasks + turns AS work, last_turn
'''

# Why an Agent gave its name up, by the first rule it lost on (the order above).
_RULES = ('built_in_role', 'dismissed', 'test', 'person_named', 'less_work', 'less_recent', 'later')


def _standing(row) -> tuple:
    """Smaller keeps the name; one entry per rule in _RULES."""
    profile = json.loads(row['profile_json'] or '{}')
    history = name_history(row['name_history_json'])
    shown = _shown(row)
    person_named = bool(history) and history[-1].reason == 'renamed' and profile.get('display_name') == shown
    recent = max(_epoch(row['last_turn']), _epoch(row['updated_at']))
    return (row['agent_id'] not in SYSTEM_NAMED, row['status'] == 'archived',
            bool(row['test_source'] or row['cleanup_eligible']), not person_named, -int(row['work'] or 0),
            -recent, (_epoch(row['created_at']), row['agent_id']))


def _epoch(text: str | None) -> float:
    """Seconds of a stored time read as text (Neo4j writes up to nanoseconds); 0 when unknown."""
    if not text:
        return 0.0
    try:
        return datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', re.sub(r'\[[^\]]*\]$', '', text)).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0.0


def _shown(row) -> str:
    profile = json.loads(row['profile_json'] or '{}')
    return agent_display_name(row['agent_id'], profile.get('name') or row['name'] or '', profile.get('display_name'))


def _names(row) -> set[str]:
    """Every name the Agent is called by: a role's built-in one too. A
    record with no name at all (no profile from an early FULI) has none."""
    keys = {identity_key(_shown(row))}
    if row['agent_id'] in SYSTEM_PROFILES:
        keys.add(identity_key(SYSTEM_PROFILES[row['agent_id']]().name))
    return keys - {''}


async def _renames(driver) -> list[dict]:
    """Every Agent that gives its name up, with its new name, by space."""
    records, _, _ = await driver.execute_query(_READ, routing_='r')
    spaces: dict[str, list] = {}
    for record in records:
        spaces.setdefault(record['space_id'], []).append(dict(record))
    renames = []
    for space_id, rows in sorted(spaces.items()):
        taken = set().union(*(_names(row) for row in rows))
        by_name: dict[str, list] = {}
        for row in rows:
            for key in _names(row):
                by_name.setdefault(key, []).append(row)
        giving_way = {}
        for key in sorted(by_name):
            group = sorted(by_name[key], key=_standing)
            keeper = group[0]
            for row in group[1:]:
                if row['agent_id'] in SYSTEM_NAMED or row['agent_id'] in giving_way:
                    continue
                lost = next(rule for rule, mine, theirs in zip(_RULES, _standing(row), _standing(keeper))
                            if mine != theirs)
                giving_way[row['agent_id']] = (row, keeper['agent_id'], lost)
        for agent_id in sorted(giving_way):
            row, kept_by, lost = giving_way[agent_id]
            name = free_nicknames(agent_id, taken, 1)[0]
            taken.add(identity_key(name))
            renames.append({'space_id': space_id, 'agent_id': agent_id, 'row': row, 'name': name,
                            'kept_by': kept_by, 'gave_way': lost})
    return renames


async def pending_unique_agent_names(driver, _settings) -> list[str]:
    """The Agents that would give their name up, by space and agent ID."""
    return sorted(f'{item["space_id"]}/{item["agent_id"]}' for item in await _renames(driver))


async def apply_unique_agent_names(driver, _settings, *, apply_id=None) -> None:
    until = now_utc()
    rows = []
    for item in await _renames(driver):
        row = item['row']
        profile = json.loads(row['profile_json'] or '{}')
        change = ProjectAgentNameChange(name=_shown(row), until=until, reason='duplicate_name',
                                        kept_by_agent_id=item['kept_by'], gave_way=item['gave_way'])
        rows.append({
            'space_id': item['space_id'], 'agent_id': item['agent_id'],
            # Only the shown name changes; every other profile field stays as stored.
            'profile_json': json.dumps({**profile, 'display_name': item['name']}, ensure_ascii=False,
                                       separators=(',', ':')),
            'name_history_json': with_former_name(row['name_history_json'], change),
            'display_name_key': identity_key(item['name']),
        })
    await driver.execute_query(
        '''
        UNWIND $rows AS row
        MATCH (:FuliSpace {id: row.space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
              (item:FuliProjectAgent {agent_id: row.agent_id})
        SET item.profile_json = row.profile_json, item.name_history_json = row.name_history_json,
            item.display_name_space_id = row.space_id, item.display_name_key = row.display_name_key
        ''',
        rows=rows,
    )


UNIQUE_AGENT_NAME_JOURNAL = RecordJournal(touches=(
    RecordTouch('node', _AGENTS, ('profile_json', 'name_history_json', 'display_name_space_id',
                                  'display_name_key')),
))
