"""Everything one host session recorded (rec#5 C6), read from storage.

A session is the person's FULI task session of one client: one task per
user→AI turn. Its turns come from those tasks; the transcript it saved from
the Agent conversation journal events those tasks wrote; its knowledge from the
episodes the turns' checkpoints committed, plus any episode the session itself
named as its source. Only this session's records are read: tasks by the
session's own node, journal events by its task tokens, episodes by its
checkpoints or its session and client.
"""
import json
import re

from .conversation_scope import session_conversation_ids
from .knowledge_item_view import (
    EXCERPT_LIMIT,
    episode_changes,
    item_evidence,
    item_summary,
    personal_reader_space,
    scope_projects,
)
from .knowledge_management import _read_item
from .provider_values import native_datetime
from .session_records_models import (
    SessionCaptureOff,
    SessionNotRecorded,
    SessionRecordItem,
    SessionRecords,
    SessionRecordsRead,
    SessionTurn,
    SessionTurnMessage,
)
from .store_agent_conversations import decode_event

# The newest turns, episodes and items of a long session; the rest is counted
# as truncated rather than silently dropped.
MAX_TURNS = 200
MAX_EPISODES = 100
MAX_ITEMS = 200
# Journal events read per conversation of the session.
MAX_EVENTS = 2000
USER_TEXT_CHARS = 2000
ASSISTANT_TEXT_CHARS = 280
SAVED = ('committed', 'duplicate')
# The note checkpoint-capture.js stores in place of a summary when capture was
# off. Any other checkpoint reason is the model's own words and is never read.
CAPTURE_OFF_NOTE = re.compile(r'^Capture was off for this task \((\w+): (\w+)\); FULI kept no summary\.$')
# The content-free marker transcript-capture-gap.js writes for skipped bytes.
NOT_RECORDED_EVENT = re.compile(r':not_recorded$')


async def read_session_records(store, actor: dict, request: SessionRecordsRead) -> SessionRecords:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    tasks, more_turns = await _session_tasks(store, space, request)
    turns = await _turns(store, space, request, tasks)
    episodes, more_episodes = await _session_episodes(store, space, request, tasks)
    items, more_items = await _items(store, space, episodes)
    project_ids = {turn.personal_project_id for turn in turns} | {item.origin_project_id for item in items}
    return SessionRecords(
        session_id=request.session_id, source_application=request.source_application,
        turns=turns, items=items,
        projects=await scope_projects(store, space, sorted(project for project in project_ids if project)),
        truncated=more_turns or more_episodes or more_items)


async def _session_tasks(store, space, request):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
              (:FuliTaskContextSession {id: $session_node})-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WITH task ORDER BY task.created_at DESC, task.id LIMIT $limit
        RETURN task.id AS id, task.token AS token, task.turn_id AS turn_id, task.created_at AS created_at,
               task.personal_project_id AS project_id, task.project_agent_id AS agent_id,
               task.record_json AS record_json
        ''', space_id=space['id'], limit=MAX_TURNS + 1,
        session_node=store._task_session_id(space['id'], request.source_application, request.session_id),
        routing_='r')
    tasks = []
    for record in reversed(records[:MAX_TURNS]):
        checkpoint = (json.loads(record['record_json'] or '{}').get('checkpoint') or {})
        tasks.append({**dict(record), 'created_at': native_datetime(record['created_at']),
                      'capture_off': _capture_off(checkpoint),
                      'episode_ids': [result['episode_id'] for result in checkpoint.get('capture_results') or []
                                      if result.get('status') in SAVED and result.get('episode_id')]})
    return tasks, len(records) > MAX_TURNS


def _capture_off(checkpoint):
    note = CAPTURE_OFF_NOTE.match(checkpoint.get('reason') or '')
    if note:
        return SessionCaptureOff(layer=note.group(1), reason=note.group(2))
    return SessionCaptureOff(reason='capture_disabled') if checkpoint.get('capture_status') == 'capture_disabled' else None


async def _turns(store, space, request, tasks):
    """Each task's saved transcript messages and skipped-bytes markers. A
    session writes to one conversation per Agent it worked with."""
    by_token = {task['token']: task for task in tasks}
    conversation_by_agent, events_by_token = {}, {}
    for key in {(task['project_id'], task['agent_id']) for task in tasks if task['agent_id']}:
        conversation_ids = await session_conversation_ids(store, space['id'], *key, request.source_application,
                                                          request.session_id)
        conversation_by_agent[key] = conversation_ids[0]
        for conversation_id in conversation_ids:
            for token, event in await _conversation_events(store, conversation_id, list(by_token)):
                events_by_token.setdefault(token, []).append(event)
    return [SessionTurn(
        task_id=task['id'], turn_id=task['turn_id'], created_at=task['created_at'],
        personal_project_id=task['project_id'],
        conversation_id=conversation_by_agent.get((task['project_id'], task['agent_id'])),
        capture_off=task['capture_off'],
        **_turn_events(events_by_token.get(task['token'], [])),
    ) for task in tasks]


async def _conversation_events(store, conversation_id, tokens):
    """(token, event) for the session's own events, in journal order, with the
    time of the event before each one so a skipped stretch has a start."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliConversation {id: $id})-[:HAS_EVENT]->(event:FuliConversationEvent)
        WITH event ORDER BY event.sequence DESC LIMIT $limit
        RETURN event.payload AS payload, event.sequence AS sequence, event.created_at AS created_at,
               event.task_context_token AS token
        ORDER BY sequence
        ''', id=conversation_id, limit=MAX_EVENTS, routing_='r')
    events, previous = [], None
    for record in records:
        created_at = native_datetime(record['created_at'])
        if record['token'] in tokens:
            events.append((record['token'], {**decode_event(record), 'created_at': created_at, 'after': previous}))
        previous = created_at or previous
    return events


def _turn_events(events):
    messages, markers = [], []
    for event in sorted(events, key=lambda value: value['sequence']):
        if NOT_RECORDED_EVENT.search(event.get('event_id') or ''):
            markers.append(SessionNotRecorded(content=event['content'], created_at=event['created_at'],
                                              after=event['after']))
        elif event['role'] in ('user', 'assistant') and event.get('kind', 'message') == 'message':
            limit = USER_TEXT_CHARS if event['role'] == 'user' else ASSISTANT_TEXT_CHARS
            messages.append(SessionTurnMessage(role=event['role'], text=_bounded(event['content'], limit),
                                               created_at=event['created_at']))
    return {'messages': messages, 'not_recorded': markers}


def _bounded(text, limit):
    return text if len(text) <= limit else f'{text[:limit]}…'


async def _session_episodes(store, space, request, tasks):
    """The episodes the session's checkpoints committed and those that name the
    session as their source, newest last, each with the turn it belongs to."""
    task_by_episode = {episode_id: task for task in tasks for episode_id in task['episode_ids']}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN $episode_ids
           OR (episode.fuli_session_id = $session_id AND episode.fuli_source_application = $source_application)
        WITH episode ORDER BY episode.created_at DESC, episode.uuid LIMIT $limit
        RETURN episode.uuid AS id, episode.created_at AS created_at,
               episode.fuli_personal_project_id AS project_id, episode.fuli_conversation_id AS conversation_id,
               episode.fuli_source_excerpt AS excerpt
        ''', group_id=space['group_id'], episode_ids=list(task_by_episode), session_id=request.session_id,
        source_application=request.source_application, limit=MAX_EPISODES + 1, routing_='r')
    episodes = []
    for record in reversed(records[:MAX_EPISODES]):
        created_at = native_datetime(record['created_at'])
        task = task_by_episode.get(record['id']) or _task_at(tasks, created_at)
        episodes.append({'id': record['id'], 'created_at': created_at, 'task': task,
                         'conversation_id': record['conversation_id'],
                         'origin_project_id': task['project_id'] if task else record['project_id'],
                         'excerpt': (record['excerpt'] or '')[:EXCERPT_LIMIT] or None})
    return episodes, len(records) > MAX_EPISODES


def _task_at(tasks, moment):
    """The turn an episode without a checkpoint receipt was written in: the
    last task that began before it."""
    if moment is None:
        return None
    started = [task for task in tasks if task['created_at'] is not None and task['created_at'] <= moment]
    return started[-1] if started else None


async def _items(store, space, episodes):
    """What each episode created or updated, and the preferences it only cited
    again (its words became their evidence). Other items mentioned again
    changed nothing and are left out."""
    items, seen = [], set()
    for episode in episodes:
        for item_kind, item_id, change in await episode_changes(store, space, [episode['id']]):
            if (item_kind, item_id) in seen:
                continue
            current = await _read_item(store, space, item_id, item_kind)
            if current is None or (change is None and not current.get('profile_aspect')):
                continue
            if len(items) == MAX_ITEMS:
                return items, True
            seen.add((item_kind, item_id))
            _, source_ids = await item_evidence(store, space, item_kind, item_id, limit=0)
            summary = await item_summary(store, space, item_kind, item_id, current, source_ids=source_ids)
            items.append(SessionRecordItem(
                **summary.model_dump(), change=change or 'evidence', episode_id=episode['id'],
                task_id=episode['task']['id'] if episode['task'] else None, recorded_at=episode['created_at'],
                origin_project_id=episode['origin_project_id'], conversation_id=episode['conversation_id'],
                excerpt=episode['excerpt']))
    return items, False
