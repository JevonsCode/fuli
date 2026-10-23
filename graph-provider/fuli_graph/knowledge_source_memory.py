"""Exact source-owned working-memory copies and optional later revisions."""
import json

from fastapi import HTTPException

from .provider_values import json_object, stable_uuid
from .project_agent_names import agent_display_name


async def source_memory_plan(store, space, target, inventory, include, exclude):
    rows, _, _ = await store.runtime.driver.execute_query(
        '''MATCH (head:FuliProjectAgentMemory {personal_space_id: $space_id})-
                 [:HAS_MEMORY_CHECKPOINT]->(checkpoint:FuliProjectAgentMemoryCheckpoint)
           OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (agent:FuliProjectAgent)-[:HAS_WORKING_MEMORY]->(head)
           RETURN head, checkpoint, collect(agent)[0] AS agent ORDER BY head.id, checkpoint.revision''',
        space_id=space['id'], routing_='r')
    exact_ids = set()
    if not target.whole_session:
        for task in inventory['memory_targets']:
            memory_id = await store._resolved_agent_memory_id(space['id'], task['project_id'], task['agent_id'])
            exact_ids.add(stable_uuid(memory_id, f'{task["token"]}:memory'))
    heads = {}
    for row in rows:
        head, checkpoint = dict(row['head']), dict(row['checkpoint'])
        agent = row.get('agent')
        profile = json_object(agent.get('profile_json')) if agent else {}
        if agent:
            head['agent_id'] = agent['agent_id']
        record = json_object(checkpoint['record_json'])
        if checkpoint.get('memory_state') == 'scrubbed' or record.get('memory_state') == 'scrubbed':
            continue
        same_session = (record.get('source_application') == target.source_application
                        and record.get('source_session_id') == target.session_id)
        exact = same_session if target.whole_session else checkpoint['id'] in exact_ids
        group = heads.setdefault(head['id'], {'head': head, 'exact': [], 'others': [],
            'agent_name': agent_display_name(head['agent_id'], profile['name'], profile.get('display_name'))
                          if profile.get('name') else None})
        group['exact' if exact else 'others'].append(checkpoint)
    preview = {'scrubbed': [], 'later': []}
    selected, versions, scopes, valid = [], [], [], set()
    direct_count = later_count = 0
    for head_id, group in sorted(heads.items()):
        if not group['exact']:
            continue
        head, direct = group['head'], group['exact']
        first = min(row['revision'] for row in direct)
        # Only other sessions are a derived layer. Same-session revisions outside
        # one exact turn are not silently widened into that turn's deletion.
        later = [row for row in group['others'] if row['revision'] > first
                 and (json_object(row['record_json']).get('source_application'),
                      json_object(row['record_json']).get('source_session_id'))
                     != (target.source_application, target.session_id)]
        scope = {'agent_id': head['agent_id'], 'personal_project_id': head.get('personal_project_id'),
                 'current_revision': head['revision']}
        display = {**scope, 'agent_name': group['agent_name']}
        preview['scrubbed'].append({**display, 'revisions': sorted(row['revision'] for row in direct),
                                    'current': any(row['revision'] == head['revision'] for row in direct)})
        key = 'memory:' + head_id
        chosen = key in include
        if later:
            valid.add(key)
            preview['later'].append({**display, 'key': key, 'from_revision': first,
                                    'revisions': sorted(row['revision'] for row in later), 'selected': chosen})
        cleared = [*direct, *(later if chosen else [])]
        selected.extend(cleared)
        scopes.append({**scope, 'revisions': sorted(row['revision'] for row in cleared)})
        versions.append([head_id, head['revision'], sorted(row['id'] for row in [*direct, *later])])
        direct_count += len(direct)
        later_count += len(later) if chosen else 0
    if (set(include) | set(exclude)) - valid:
        raise HTTPException(422, detail={'code': 'source_selection_invalid', 'message': 'Unknown working-memory selection'})
    return {'preview': preview, 'checkpoints': selected, 'versions': versions, 'scopes': scopes,
            'direct_count': direct_count, 'later_count': later_count}


async def scrub_source_memory(store, space, plan, deletion_id):
    for checkpoint in plan['checkpoints']:
        old = json_object(checkpoint['record_json'])
        record = {key: old[key] for key in ('checkpoint_id', 'personal_space_id', 'personal_project_id',
                  'agent_id', 'revision', 'created_at')}
        record.update(memory=None, memory_state='scrubbed', scrubbed_by=deletion_id)
        await store.runtime.driver.execute_query(
            '''MATCH (:FuliProjectAgentMemory {personal_space_id: $space_id})-[:HAS_MEMORY_CHECKPOINT]->
                     (checkpoint:FuliProjectAgentMemoryCheckpoint {id: $id})
               WHERE coalesce(checkpoint.memory_state, 'present') <> 'scrubbed'
               SET checkpoint.record_json=$record, checkpoint.memory_state='scrubbed',
                   checkpoint.scrubbed_by=$deletion_id
               REMOVE checkpoint.payload_hash''', space_id=space['id'], id=checkpoint['id'],
            record=json.dumps(record, ensure_ascii=False, separators=(',', ':')), deletion_id=deletion_id)


async def deleted_memory_scopes(store, space, deletion_id):
    """Rebuild a local cleanup receipt without persisting checkpoint ID lists."""
    rows, _, _ = await store.runtime.driver.execute_query(
        '''MATCH (head:FuliProjectAgentMemory {personal_space_id: $space_id})-[:HAS_MEMORY_CHECKPOINT]->
                 (checkpoint:FuliProjectAgentMemoryCheckpoint {scrubbed_by: $deletion_id})
           OPTIONAL MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                 (agent:FuliProjectAgent)-[:HAS_WORKING_MEMORY]->(head)
           WITH head, checkpoint, collect(agent)[0] AS agent
           RETURN coalesce(agent.agent_id, head.agent_id) AS agent_id, head.personal_project_id AS personal_project_id,
                  head.revision AS current_revision, checkpoint.revision AS revision
           ORDER BY head.id, checkpoint.revision''', space_id=space['id'], deletion_id=deletion_id, routing_='r')
    scopes = {}
    for row in rows:
        key = (row['agent_id'], row['personal_project_id'])
        scope = scopes.setdefault(key, {name: row[name] for name in ('agent_id', 'personal_project_id', 'current_revision')})
        scope.setdefault('revisions', []).append(row['revision'])
    return list(scopes.values())
