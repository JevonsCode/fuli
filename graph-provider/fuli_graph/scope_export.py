"""Export one scope of a personal space as one deterministic envelope
(docs/runner-roles-design.md, "Scopes in the graph").

The envelope is what a read-only copy of a scope, or a scope moved to another
computer, is made from: every node and relationship of the scope with its
properties and history, the complete ID sets an importer compares against,
the IDs of nodes outside the scope that its relationships reach, and a digest
of all of it. Two exports of unchanged data differ only in exportedAt.

Read only: everything is read in one transaction in Neo4j's read access mode,
so the database itself refuses a write. Each label is one streamed query
(the driver pulls its records in batches) and nodes found under a parent are
asked for in chunks of parents. scope_classifier.py decides what belongs where;
nothing here imports, and nothing calls this but the Provider route below.
"""
import json
from collections import defaultdict
from math import isfinite
from typing import Annotated

from fastapi import HTTPException
from fastapi.responses import Response
from neo4j.time import Date, DateTime, Duration, Time
from pydantic import Field

from .graph_format_migrations import GRAPH_FORMAT_VERSION
from .model_base import StrictModel
from .provider_values import now_utc, sha256_text
from .runtime import LocalHashEmbedder
from .scope_classifier import (
    DERIVED_PROPERTIES, GLOBAL, NODE_RULES, PROJECT_PREFIX, RELATIONSHIP_KEYS, RELATIONSHIP_RULES, SPACE_LABEL,
    GraphNode, GraphRelationship, ScopeClassification, conversation_scopes, exported,
)

REPLICA_PROTOCOL = 1
# How many parents (or relationship starts) one query names.
ELEMENT_CHUNK = 1000
_TEMPORAL = ((DateTime, 'datetime'), (Date, 'date'), (Time, 'time'), (Duration, 'duration'))
_CONVERSATION_SOURCES = ('FuliProjectAgent', 'FuliProjectAgentAlias', 'FuliPersonalProject')


class ScopeExportRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    scope: Annotated[str, Field(min_length=6, max_length=140, pattern=r'^(global|project:\S+)$')]
    # Off for a lighter envelope: the importer computes the vectors again.
    vectors: bool = True


async def export_scope(store, actor, request: ScopeExportRequest) -> dict:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='a scope export needs a personal space')
    async with store.runtime.driver.read_transaction() as transaction:
        classification = await _read_space(transaction, space)
    if request.scope != GLOBAL and request.scope.removeprefix(PROJECT_PREFIX) not in classification.project_ids:
        raise HTTPException(status_code=404, detail={'code': 'scope_not_found',
                                                     'message': 'this personal space has no such project'})
    embedding_model = f'{LocalHashEmbedder.version}/{store.settings.embedding_dim}' if request.vectors else None
    return _envelope(space, request.scope, classification, vectors=request.vectors,
                     embedding_model=embedding_model)


# Reading ---------------------------------------------------------------------

async def _rows(transaction, query, **parameters):
    result = await transaction.run(query, **parameters)
    return [record async for record in result]


def _chunks(values):
    values = sorted(values)
    for start in range(0, len(values), ELEMENT_CHUNK):
        yield values[start:start + ELEMENT_CHUNK]


def _read_order() -> list[str]:
    """Exported labels, each after the labels it is found through."""
    ordered, pending = [], [label for label, rule in NODE_RULES.items() if exported(rule)]
    while pending:
        ready = [label for label in pending if all(need in ordered for need in _needs(label))]
        if not ready:
            raise ValueError(f'labels found through each other: {sorted(pending)}')
        ordered.extend(ready)
        pending = [label for label in pending if label not in ready]
    return ordered


def _needs(label) -> tuple[str, ...]:
    found = NODE_RULES[label].found
    if found[0] == 'child' and found[2] != SPACE_LABEL:
        return (found[2],)
    return _CONVERSATION_SOURCES if found[0] == 'conversation' else ()


async def _read_space(transaction, space) -> ScopeClassification:
    space_row = await _rows(transaction, "MATCH (space:FuliSpace {id: $id, kind: 'personal'}) "
                                         'RETURN elementId(space) AS element_id', id=space['id'])
    space_element = space_row[0]['element_id']
    nodes: dict[str, GraphNode] = {}
    conversations = None
    for label in _read_order():
        kind, *found = NODE_RULES[label].found
        if kind == 'conversation' and conversations is None:
            conversations = _conversations(space['id'], nodes)
        for record in await _found_rows(transaction, label, kind, found, space, space_element, nodes,
                                        conversations):
            node = nodes.setdefault(record['element_id'], GraphNode(
                record['element_id'], label, tuple(sorted(record['labels'])), dict(record['properties'])))
            if record.get('parent'):
                node.parents.add(record['parent'])
    relationships = []
    for starts in _chunks([space_element, *nodes]):
        for record in await _rows(transaction, '''
            MATCH (start)-[relationship]->(end) WHERE elementId(start) IN $starts
            RETURN elementId(relationship) AS element_id, type(relationship) AS type,
                   elementId(start) AS start, elementId(end) AS end, properties(relationship) AS properties
            ''', starts=starts):
            if record['end'] in nodes or record['end'] == space_element:
                relationships.append(GraphRelationship(record['element_id'], record['type'], record['start'],
                                                       record['end'], dict(record['properties'])))
    return ScopeClassification(space_element, nodes, relationships, conversations or {})


def _conversations(space_id, nodes) -> dict:
    agents = {node.properties.get('agent_id') for node in nodes.values()
              if node.label in ('FuliProjectAgent', 'FuliProjectAgentAlias')} - {None}
    projects = {node.properties.get('project_id') for node in nodes.values()
                if node.label == 'FuliPersonalProject'} - {None}
    return conversation_scopes(space_id, sorted(agents), sorted(projects))


async def _found_rows(transaction, label, kind, found, space, space_element, nodes, conversations):
    returns = 'RETURN elementId(node) AS element_id, labels(node) AS labels, properties(node) AS properties'
    if kind == 'group':
        return await _rows(transaction, f'MATCH (node:{label}) WHERE node.group_id = $group_id {returns}',
                           group_id=space['group_id'])
    if kind == 'space':
        return await _rows(transaction, f'MATCH (node:{label}) WHERE node.{found[0]} = $space_id {returns}',
                           space_id=space['id'])
    if kind == 'conversation':
        return await _rows(transaction, f'MATCH (node:{label}) WHERE node.{found[0]} IN $scopes {returns}',
                           scopes=sorted(conversations))
    relationship, parent_label = found
    parents = [space_element] if parent_label == SPACE_LABEL else [
        element for element, node in nodes.items() if node.label == parent_label]
    rows = []
    for chunk in _chunks(parents):
        rows += await _rows(transaction, f'''
            MATCH (parent)-[:{relationship}]->(node:{label}) WHERE elementId(parent) IN $parents
            {returns}, elementId(parent) AS parent''', parents=chunk)
    return rows


# The envelope ------------------------------------------------------------------

def _value(value):
    """A property as JSON: a graph time keeps its type, a list its order."""
    for kind, name in _TEMPORAL:
        if isinstance(value, kind):
            return {'$' + name: value.iso_format()}
    if isinstance(value, (list, tuple)):
        return [_value(item) for item in value]
    if isinstance(value, float) and not isfinite(value):
        return {'$float': repr(value)}
    return value


def _properties(properties: dict, *, vectors: bool) -> dict:
    return {key: _value(properties[key]) for key in sorted(properties)
            if vectors or key not in DERIVED_PROPERTIES}


def _node_id(node: GraphNode) -> str:
    values = [node.properties.get(key) for key in NODE_RULES[node.label].key]
    if any(value in (None, '') for value in values):
        # No identity of its own (an early record): this export names it, no other computer can.
        return f'{node.label}:element:{node.element_id}'
    return f'{node.label}:' + '/'.join(str(value) for value in values)


def _relationship_ids(relationships, node_ids) -> dict[str, str]:
    """Each relationship's ID: its own key where its type has one, else its
    type and ends; equal IDs are told apart by their properties' order."""
    named = defaultdict(list)
    for relationship in relationships:
        key = relationship.properties.get(RELATIONSHIP_KEYS.get(relationship.type, ''))
        base = (f'{relationship.type}:{key}' if key else
                f'{relationship.type}:{node_ids[relationship.start]}->{node_ids[relationship.end]}')
        named[base].append(relationship)
    ids = {}
    for base, group in named.items():
        if len(group) == 1:
            ids[group[0].element_id] = base
            continue
        group.sort(key=lambda item: _canonical(_properties(item.properties, vectors=True)))
        for index, relationship in enumerate(group):
            ids[relationship.element_id] = f'{base}#{index}'
    return ids


def _home(scopes) -> str:
    """Where an importer finds a node this scope only points at."""
    return GLOBAL if GLOBAL in scopes else min(scopes)


def _canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _envelope(space, scope, classification: ScopeClassification, *, vectors, embedding_model) -> dict:
    nodes, relationships = classification.nodes, classification.relationships
    node_ids = {element: _node_id(node) for element, node in nodes.items()}
    node_ids[classification.space_element_id] = f'{SPACE_LABEL}:{space["id"]}'
    relationship_ids = _relationship_ids(relationships, node_ids)
    relationship_scopes = {relationship.element_id: classification.relationship_scopes(relationship)
                           for relationship in relationships}
    in_scope = {element for element in nodes if scope in classification.node_scopes(element)}
    chosen = [relationship for relationship in relationships if scope in relationship_scopes[relationship.element_id]]
    external = {}
    for relationship in chosen:
        for end in (relationship.start, relationship.end):
            if end != classification.space_element_id and end not in in_scope:
                external[node_ids[end]] = _home(classification.node_scopes(end))
    for element in in_scope:
        for reference in classification.references.get(element, ()):
            if reference in nodes and reference not in in_scope:
                external[node_ids[reference]] = _home(classification.node_scopes(reference))
            elif reference in relationship_scopes and scope not in relationship_scopes[reference]:
                external[relationship_ids[reference]] = _home(relationship_scopes[reference])
    node_entries = sorted(({
        'id': node_ids[element], 'labels': list(nodes[element].labels),
        'scopes': sorted(classification.node_scopes(element)),
        'properties': _properties(nodes[element].properties, vectors=vectors),
    } for element in in_scope), key=lambda entry: entry['id'])
    relationship_entries = sorted(({
        'id': relationship_ids[relationship.element_id], 'type': relationship.type,
        'start': node_ids[relationship.start], 'end': node_ids[relationship.end],
        'scopes': sorted(relationship_scopes[relationship.element_id]),
        'properties': _properties(relationship.properties, vectors=vectors),
    } for relationship in chosen), key=lambda entry: entry['id'])
    body = {
        'replicaProtocol': REPLICA_PROTOCOL, 'graphFormat': GRAPH_FORMAT_VERSION,
        'embeddingModel': embedding_model, 'vectors': vectors,
        'spaceId': space['id'], 'groupId': space['group_id'], 'scope': scope,
        'nodes': node_entries, 'relationships': relationship_entries,
        'ids': {'nodes': [entry['id'] for entry in node_entries],
                'relationships': [entry['id'] for entry in relationship_entries]},
        'externalRefs': [{'id': ref, 'scope': external[ref]} for ref in sorted(external)],
        'unclassifiedRelationshipTypes': sorted({relationship.type for relationship in relationships
                                                 if relationship.type not in RELATIONSHIP_RULES}),
    }
    return {**body, 'exportedAt': now_utc().isoformat(), 'digest': sha256_text(_canonical(body))}


def register_scope_export_route(application, store, Actor) -> None:
    # Read only, but it gives a whole scope at once: the console's own process
    # asks for it with the Provider's access token; no Agent tool reaches it.
    @application.post('/v1/scopes/export')
    async def scope_export(request: ScopeExportRequest, actor: Actor) -> Response:
        envelope = await export_scope(store, actor, request)
        return Response(content=_canonical(envelope), media_type='application/json')
