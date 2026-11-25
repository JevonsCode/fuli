"""Inspect and change only a sealed project's graph/25 records."""
from fastapi import HTTPException

from .handover_permission import handover_transaction
from .handover_task_history import archive_task_history, check_task_history
from .provider_values import now_utc, sha256_text, stable_uuid
from .scope_export import (_envelope, _relationship_ids, _select, canonical, exported_properties,
                           node_id, read_space, SPACE_LABEL)
from .scope_import import OWNER, SCOPES, OWNER_DELETED_AT, _batches, _run


def refuse(code, **details):
    raise HTTPException(409, detail={'code': code, **details})


def marker(properties, scope):
    owner = properties.get(OWNER)
    if not owner:
        return None
    if properties.get(OWNER_DELETED_AT) or properties.get(SCOPES) != [scope]:
        refuse('project_move_shared_copy')
    return owner


def external_bindings(read, image, space_id):
    refs = {row['id']: row['scope'] for row in image['externalRefs']}
    if any(scope != 'global' for scope in refs.values()):
        refuse('project_move_cross_project_reference')
    graph = read.classification
    ids = {key: node_id(node) for key, node in graph.nodes.items()}
    ids[graph.space_element_id] = f'{SPACE_LABEL}:{space_id}'
    named = [link for link in graph.relationships if ids.get(link.start) and ids.get(link.end)]
    edges = _relationship_ids(named, ids)
    bindings = {}
    def bind(key, value):
        if key in bindings:
            refuse('project_move_ambiguous_reference', record=key)
        bindings[key] = sha256_text(canonical(value))
    for element, node in graph.nodes.items():
        key = ids[element]
        if key in refs:
            if node.properties.get(OWNER_DELETED_AT):
                refuse('project_move_missing_reference', record=key)
            bind(key, [sorted(node.labels), exported_properties(node.properties)])
    for edge in named:
        key = edges[edge.element_id]
        if key in refs:
            if edge.properties.get(OWNER_DELETED_AT):
                refuse('project_move_missing_reference', record=key)
            bind(key, [edge.type, ids[edge.start], ids[edge.end], exported_properties(edge.properties)])
    if set(bindings) != refs.keys():
        refuse('project_move_missing_reference')
    return bindings


async def inspect_project(tx, space, project, provider_id, *, readiness=True):
    scope = 'project:' + project
    read = await read_space(tx, space)
    graph = read.classification
    selection = _select(graph, scope)
    owners = set()
    contexts = []
    for element in list(selection.nodes):
        node = graph.nodes[element]
        scopes = graph.node_scopes(element)
        # A global identity required by a project stays external. A record
        # genuinely owned by two scopes cannot be promoted independently.
        if scopes != {scope}:
            refuse('project_move_shared_record', record=node_id(node), scopes=sorted(scopes))
        owners.add(marker(node.properties, scope))
        if node.label == 'FuliTaskContext':
            contexts.append(element)
        if readiness and node.label == 'FuliProjectAgentTask' and node.properties.get('status') not in ('completed','failed','cancelled'):
            refuse('project_tasks_still_active', record=node_id(node))
        if readiness and node.label == 'FuliProjectAgentRecruitment' and node.properties.get('status') not in ('fulfilled','cancelled','no_hr'):
            refuse('project_recruitment_pending', record=node_id(node))
    for edge in selection.relationships:
        scopes = graph.relationship_scopes(edge)
        if scopes != {scope}:
            refuse('project_move_shared_record', scopes=sorted(scopes))
        owners.add(marker(edge.properties, scope))
    if len(owners) > 1:
        refuse('project_move_mixed_owners')
    image = _envelope(space, scope, read, selection, vectors=False, embedding_model=None)
    root = 'FuliPersonalProject:' + stable_uuid(provider_id, space['id'], 'personal-project', project)
    if not image['complete'] or root not in image['ids']['nodes']:
        refuse('project_move_incomplete_graph')
    if any(row['type'] == 'PERSONAL_PROJECT_RELATION' and row['properties'].get('relation_type') == 'PART_OF'
           and row['properties'].get('status', 'active') == 'active' for row in image['relationships']):
        refuse('project_move_hierarchy_dependency')
    if readiness:
        await check_task_history(tx, space['id'], project)
    bindings = external_bindings(read, image, space['id'])
    digest = sha256_text(canonical([image['digest'], bindings]))
    return {'envelope': image, 'bindings': bindings, 'digest': digest}, selection, contexts, owners.pop()


async def set_markers(tx, selection, owner, scope):
    for elements, match in [
        (selection.nodes, 'MATCH (item)'),
        ([edge.element_id for edge in selection.relationships], 'MATCH ()-[item]->()'),
    ]:
        for chunk in _batches(sorted(elements)):
            action = ('REMOVE item.fuli_replica_owner, item.fuli_replica_scopes, item.fuli_replica_synced_at, '
                      'item.fuli_replica_owner_deleted_at' if owner is None else
                      'SET item.fuli_replica_owner=$owner, item.fuli_replica_scopes=[$scope], item.fuli_replica_synced_at=$now')
            rows = await _run(tx, match + ' WHERE elementId(item) IN $ids ' + action + ' RETURN count(item) AS total',
                              ids=chunk, owner=owner, scope=scope, now=now_utc())
            if rows[0]['total'] != len(chunk):
                refuse('project_move_record_changed')


async def convert(store, space, project, move_id, phase, control):
    source, target = control['source'], control['target']
    promote = phase == 'promote'
    expected, wanted = (source, None) if promote else (None, target)
    # The closed gate stays held across this transaction and the refresh.
    async with handover_transaction(store.runtime.driver) as tx:
        data, selection, contexts, observed = await inspect_project(tx, space, project, store.settings.provider_id)
        if data['digest'] != control['graph_digest']:
            refuse('project_move_digest_changed')
        if observed != wanted:
            if observed != expected:
                refuse('project_move_wrong_owner')
            await archive_task_history(tx, space['id'], project, move_id, contexts)
            await set_markers(tx, selection, wanted, 'project:' + project)
        verified, _, _, owner = await inspect_project(tx, space, project, store.settings.provider_id)
        if owner != wanted or verified['digest'] != data['digest']:
            refuse('project_move_verification_failed')
    return {'ok': True, 'digest': data['digest'], 'phase': phase, 'moveId': move_id}


async def stage(store, actor, space, project, phase, control, bundle):
    from .scope_import import _Local, _Writer, _local_space, _plan, check_envelope
    if not isinstance(bundle, dict) or not isinstance(bundle.get('envelope'), dict) or not isinstance(bundle.get('bindings'), dict):
        refuse('project_move_package_invalid')
    image = check_envelope(bundle['envelope'])
    digest = sha256_text(canonical([image.digest, bundle['bindings']]))
    expected = control['graph_digest'] if phase == 'stage' else control['baseline_digest']
    if image.scope != 'project:' + project or image.spaceId != space['id'] or digest != expected:
        refuse('project_move_package_changed')
    await _local_space(store, actor, image)
    plan = await _plan(store, image)
    async with handover_transaction(store.runtime.driver) as tx:
        read = await read_space(tx, space)
        if project in read.classification.project_ids:
            prior, _, _, owner = await inspect_project(tx, space, project, store.settings.provider_id)
            if owner != control['source'] or prior['digest'] not in (control['graph_digest'], control['baseline_digest']):
                refuse('project_move_target_changed')
            if prior['digest'] == digest:
                return {'ok': True, 'digest': digest, 'phase': phase}
        elif phase == 'stage' and control['baseline_digest']:
            refuse('project_move_target_changed')
        if external_bindings(read, bundle['envelope'], space['id']) != bundle['bindings']:
            refuse('project_move_external_content_changed')
        local = _Local(read, space, image, control['source'])
        local.check(plan)
        imported = await _Writer(tx, local, plan, control['source'], now_utc()).run()
        if imported['dangling']['count']:
            refuse('project_move_missing_reference')
        verified, _, _, owner = await inspect_project(tx, space, project, store.settings.provider_id)
        if verified['digest'] != digest or owner != control['source']:
            refuse('project_move_verification_failed')
    return {'ok': True, 'digest': digest, 'phase': phase}


async def discard_staged(store, space, project, control):
    if control['baseline_digest'] is not None:
        refuse('project_move_baseline_required')
    async with handover_transaction(store.runtime.driver) as tx:
        read = await read_space(tx, space)
        if project not in read.classification.project_ids:
            return {'ok': True, 'phase': 'discard'}
        data, selection, contexts, owner = await inspect_project(tx, space, project, store.settings.provider_id)
        if owner != control['source'] or data['digest'] != control['graph_digest']:
            refuse('project_move_target_changed')
        for ids in _batches(sorted(edge.element_id for edge in selection.relationships)):
            await _run(tx, 'MATCH ()-[edge]->() WHERE elementId(edge) IN $ids DELETE edge', ids=ids)
        session_id = stable_uuid('fuli-replica-task-session', space['id'], control['source'])
        for ids in _batches(sorted(contexts)):
            await _run(tx, """MATCH (:FuliTaskContextSession {id:$session})-[edge:HAS_CONTEXT]->(task)
                WHERE elementId(task) IN $ids AND edge.fuli_replica_owner=$owner DELETE edge""",
                       session=session_id, owner=owner, ids=ids)
        # Ordinary DELETE lets Neo4j refuse any surviving edge to other data.
        for ids in _batches(sorted(selection.nodes)):
            await _run(tx, 'MATCH (n) WHERE elementId(n) IN $ids DELETE n', ids=ids)
    return {'ok': True, 'phase': 'discard'}
