"""The graph's part of the person's weekly compounding statement (复利账单).

Counts only, for one personal space and one window: how many items stand
confirmed at each week's end, what was learned and retired in the window,
the uses Agents reported, the Agent tasks that ended and the questions the
person answered. Five aggregate queries, run side by side; no item text,
no id and no vector leaves the Provider, and nothing is scanned in Python.

Who confirmed an item is read from its stored confirmation basis, a JSON
string every writer serialises with json.dumps(sort_keys=True); Cypher has no
JSON parser, so the queries match the exact fragments that serialisation
spells (test_knowledge_statement.py checks them against real bases). A basis
that does not hold a valid confirmation counts as unconfirmed, as
effective_confirmation_status reads it.

An item counts from the later of its confirmation and its own creation: a new
version carries its predecessor's confirmation, and must not be counted
before it existed. A new version is neither captured nor retired: the edit
keeps the same knowledge current (fuli_replaced_by_item_id links the two).
"""
import asyncio
import json
from datetime import datetime

from pydantic import Field, model_validator

from .knowledge_audit import AGENT_CONFIRMATION_POLICY_VERSION
from .knowledge_item_view import personal_reader_space
from .knowledge_versions import invalid_property
from .model_base import StrictModel
from .tonborg_confirmation import TONBORG_CONFIRMATION_POLICY_VERSION

MAX_POINTS = 26
# A stored confirmation time Neo4j's datetime() reads; anything else counts as absent.
_INSTANT = r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?'


def _key_fragment(value: dict, *, open_value: bool) -> str:
    """One top-level key as the basis serialisation spells it; with
    open_value, only up to the start of its value."""
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)[1:-1]
    return text[:-1] if open_value else text


BASIS_FRAGMENTS = {
    'by_user': _key_fragment({'confirmed_by': {'kind': 'user'}}, open_value=True),
    'by_source': _key_fragment({'confirmed_by': {'kind': 'authoritative_source'}}, open_value=True),
    'by_agent': _key_fragment({'confirmed_by': {'kind': 'agent'}}, open_value=True),
    'any_policy': _key_fragment({'agent_policy_version': ''}, open_value=True),
    'tonborg_policy': _key_fragment({'agent_policy_version': TONBORG_CONFIRMATION_POLICY_VERSION}, open_value=False),
    'usage_policy': _key_fragment({'agent_policy_version': AGENT_CONFIRMATION_POLICY_VERSION}, open_value=False),
    'confirmed_at_key': _key_fragment({'confirmed_at': ''}, open_value=True),
}


class KnowledgeStatementRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    since: datetime
    until: datetime
    # Each week's end, oldest first; the last one is `until`.
    points: list[datetime] = Field(min_length=1, max_length=MAX_POINTS)

    @model_validator(mode='after')
    def validate_window(self):
        instants = [self.since, self.until, *self.points]
        if any(value.tzinfo is None for value in instants):
            raise ValueError('statement times need a time zone')
        if self.since >= self.until:
            raise ValueError('since must be before until')
        if self.points != sorted(set(self.points)) or self.points[-1] != self.until:
            raise ValueError('points must rise and end at until')
        return self


class StatementUse(StrictModel):
    times: int
    tasks: int
    cited: int
    applied: int


class StatementLearned(StrictModel):
    captured: int
    confirmed_by_you: int
    confirmed_by_tonborg: int
    promoted_by_use: int
    retired: int


class StatementDone(StrictModel):
    finished: int
    failed: int


class KnowledgeStatement(StrictModel):
    # Confirmed and current at each point, aligned with the request's points.
    series: list[int]
    used: StatementUse
    learned: StatementLearned
    done: StatementDone
    answered: int


# The confirmations counted as learned: by the person, by Tonborg, or kept by
# use (a source's or another Agent's confirmation is not counted).
COUNTED_CONFIRMERS = "['you', 'tonborg', 'usage']"


def item_facts(item_kind: str) -> str:
    """Per item of the space: who confirmed it and when, when it was created
    and retired, and the instant it counts from. The weekly and the per-day
    statement both read items through this, so "learned" means one thing."""
    match = ('MATCH (item:Entity {group_id: $group_id})' if item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()')
    return match + f'''
        WITH item, coalesce(item.fuli_confirmation_basis_json, '') AS basis,
             coalesce(item.fuli_confirmation_status, 'pending') AS status,
             item.{invalid_property(item_kind)} AS retired_at, item.created_at AS created_at
        WITH item, retired_at, created_at,
             CASE
               WHEN status = 'confirmed' AND NOT basis CONTAINS $any_policy
                    AND (basis CONTAINS $by_user OR basis CONTAINS $by_source)
                 THEN CASE WHEN basis CONTAINS $by_user THEN 'you' ELSE 'source' END
               WHEN status = 'agent_confirmed' AND basis CONTAINS $by_agent AND basis CONTAINS $any_policy
                 THEN CASE WHEN basis CONTAINS $tonborg_policy THEN 'tonborg'
                           WHEN basis CONTAINS $usage_policy THEN 'usage' ELSE 'agent' END
             END AS confirmer,
             CASE WHEN basis CONTAINS $confirmed_at_key
                  THEN split(split(basis, $confirmed_at_key)[1], '"')[0] END AS confirmed_text
        WITH item, retired_at, created_at, confirmer,
             CASE WHEN confirmed_text =~ $instant THEN datetime(confirmed_text) END AS confirmed_at
        WITH item, retired_at, created_at, confirmer, confirmed_at,
             CASE WHEN confirmed_at IS NULL OR created_at > confirmed_at
                  THEN coalesce(created_at, confirmed_at) ELSE confirmed_at END AS counted_from
        '''


def items_query(item_kind: str) -> str:
    return item_facts(item_kind) + f'''
        WITH collect(CASE WHEN confirmer IS NOT NULL AND counted_from IS NOT NULL
                          THEN [counted_from, retired_at] END) AS confirmed,
             collect(item.fuli_replaced_by_item_id) AS versions,
             collect(CASE WHEN created_at >= $since AND created_at < $until THEN item.uuid END) AS created,
             collect(CASE WHEN confirmer IN {COUNTED_CONFIRMERS}
                               AND confirmed_at >= $since AND confirmed_at < $until
                          THEN [item.uuid, confirmer] END) AS confirmations,
             sum(CASE WHEN retired_at >= $since AND retired_at < $until
                           AND item.fuli_replaced_by_item_id IS NULL THEN 1 ELSE 0 END) AS retired
        WITH confirmed, created, retired,
             [row IN confirmations WHERE NOT row[0] IN versions | row[1]] AS confirmers,
             [id IN created WHERE NOT id IN versions] AS captured
        RETURN [point IN $points | size([row IN confirmed
                 WHERE row[0] <= point AND (row[1] IS NULL OR row[1] > point)])] AS series,
               size(captured) AS captured, retired,
               size([who IN confirmers WHERE who = 'you']) AS confirmed_by_you,
               size([who IN confirmers WHERE who = 'tonborg']) AS confirmed_by_tonborg,
               size([who IN confirmers WHERE who = 'usage']) AS promoted_by_use
        '''


# The uses Agents reported in the window, read by the weekly and the per-day statement.
USES_MATCH = '''
    MATCH (audit:FuliKnowledgeAudit {space_id: $space_id, action: 'knowledge_used'})
    WHERE audit.created_at >= $since AND audit.created_at < $until
'''

USES_QUERY = USES_MATCH + '''
    RETURN count(audit) AS times, count(DISTINCT audit.task_id) AS tasks,
           sum(CASE audit.use_kind WHEN 'cited' THEN 1 ELSE 0 END) AS cited,
           sum(CASE audit.use_kind WHEN 'applied' THEN 1 ELSE 0 END) AS applied
'''

# A finished task without its own completion time ends at its last change, as the task pages read it.
TASKS_QUERY = '''
    MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
          (task:FuliProjectAgentTask {personal_space_id: $space_id})
    WHERE task.status IN ['completed', 'failed']
    WITH task, coalesce(task.completed_at, task.updated_at) AS ended_at
    WHERE ended_at >= $since AND ended_at < $until
    RETURN sum(CASE task.status WHEN 'completed' THEN 1 ELSE 0 END) AS finished,
           sum(CASE task.status WHEN 'failed' THEN 1 ELSE 0 END) AS failed
'''

# An answered request is not changed again: its last change is the person's answer.
ANSWERS_QUERY = '''
    MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_AGENT_ATTENTION]->(request:FuliAgentAttention)
    WHERE request.responded_by = 'human'
      AND request.updated_at >= $since AND request.updated_at < $until
    RETURN count(request) AS questions
'''


async def knowledge_statement(store, space, request: KnowledgeStatementRequest) -> KnowledgeStatement:
    window = {'since': request.since, 'until': request.until, 'routing_': 'r'}

    async def one(query, **values):
        records, _, _ = await store.runtime.driver.execute_query(query, **window, **values)
        return dict(records[0]) if records else {}

    item_values = {'group_id': space['group_id'], 'points': request.points, 'instant': _INSTANT, **BASIS_FRAGMENTS}
    entities, relationships, uses, tasks, answers = await asyncio.gather(
        one(items_query('entity'), **item_values),
        one(items_query('relationship'), **item_values),
        one(USES_QUERY, space_id=space['id']),
        one(TASKS_QUERY, space_id=space['id']),
        one(ANSWERS_QUERY, space_id=space['id']))
    items = (entities, relationships)

    def total(field):
        return sum(int(part.get(field) or 0) for part in items)

    series = [0] * len(request.points)
    for part in items:
        for index, count in enumerate(part.get('series') or []):
            series[index] += int(count)
    return KnowledgeStatement(
        series=series,
        used=StatementUse(**{field: int(uses.get(field) or 0) for field in ('times', 'tasks', 'cited', 'applied')}),
        learned=StatementLearned(captured=total('captured'), confirmed_by_you=total('confirmed_by_you'),
                                 confirmed_by_tonborg=total('confirmed_by_tonborg'),
                                 promoted_by_use=total('promoted_by_use'), retired=total('retired')),
        done=StatementDone(finished=int(tasks.get('finished') or 0), failed=int(tasks.get('failed') or 0)),
        answered=int(answers.get('questions') or 0))


def register_knowledge_statement_route(application, store, Actor) -> None:
    @application.post('/v1/knowledge/statement', response_model=KnowledgeStatement)
    async def read_knowledge_statement(request: KnowledgeStatementRequest, actor: Actor):
        space = await personal_reader_space(store, actor, request.personal_space_id)
        return await knowledge_statement(store, space, request)
