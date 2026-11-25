"""Export one scope of a personal space as one deterministic envelope
(docs/runner-roles-design.md, "Scopes in the graph").

The envelope is what a read-only copy of a scope, or a scope moved to another
computer, is made from: every node and relationship of the scope with its
properties and history, the complete ID sets an importer compares against,
the IDs of nodes outside the scope that its relationships reach, and a digest
of all of it. Two exports of unchanged data differ only in exportedAt.

Nothing is left out silently. What the envelope cannot carry it counts:
nodes of a label in no rule (unclassifiedLabels) and relationship types in no
rule, nodes without their identity key (unidentifiedNodes: a Neo4j element ID
differs per computer, so it never appears) and the relationships they end, and
this computer's local_only records. `complete` is false when anything but the
local_only count is non-empty; such an envelope must not be imported.

Read only: everything is read in one transaction in Neo4j's read access mode,
so the database itself refuses a write. That transaction is read committed,
not a snapshot: its few dozen queries can see what another transaction commits
between them. A copy's next sync corrects that; moving a scope freezes writes
at the source first and hands over only when two exports give the same digest.

Each label is one streamed query (the driver pulls its records in batches) and
nodes found under a parent are asked for in chunks of parents. Derived
properties (vectors) are left in Neo4j by the first read; an export with
vectors reads them again for the scope's own records only. scope_classifier.py
decides what belongs where; nothing calls this but the Provider route below
and scope_import.py, which reads the importing computer's space the same way.

Only the owner exports a scope. A computer that keeps a scope as a read-only
copy (scope_import.py) refuses to export it (scope_not_owned_here), so a third
computer never takes it for the owner; a copy of another scope is left out of
this computer's own scopes and reached only as an external reference.
"""
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from math import isfinite
from typing import Annotated

from fastapi import HTTPException
from fastapi.responses import Response
from neo4j.time import Date, DateTime, Duration, Time
from pydantic import Field

from .global_replica import is_system_default
from .graph_field_contract import REPLICA_FIELDS
from .graph_format_migrations import GRAPH_FORMAT_VERSION
from .model_base import StrictModel
from .provider_values import now_utc, sha256_text
from .runtime import LocalHashEmbedder
from .scope_classifier import (
    DERIVED, DERIVED_PROPERTIES, GLOBAL, LOCAL_ONLY, NODE_RULES, PROJECT_PREFIX, RELATIONSHIP_KEYS,
    RELATIONSHIP_RULES, SPACE_LABEL,
    GraphNode, GraphRelationship, ScopeClassification, conversation_scopes, exported,
)

REPLICA_PROTOCOL = 1
# What an envelope's digest does not cover: when it was made, and this computer's own records.
_NOT_DIGESTED = frozenset({'exportedAt', 'localOnlyCount', 'digest'})
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
        read = await read_space(transaction, space)
        if (request.scope != GLOBAL
                and request.scope.removeprefix(PROJECT_PREFIX) not in read.classification.project_ids):
            raise HTTPException(status_code=404, detail={'code': 'scope_not_found',
                                                         'message': 'this personal space has no such project'})
        selection = _select(read.classification, request.scope)
        _owned_here(selection, request.scope)
        if request.vectors:
            await _add_derived(transaction, selection)
    embedding_model = f'{LocalHashEmbedder.version}/{store.settings.embedding_dim}' if request.vectors else None
    return _envelope(space, request.scope, read, selection, vectors=request.vectors,
                     embedding_model=embedding_model)


async def own_global_records(store, actor, personal_space_id: str) -> dict:
    """The records of `global` this computer holds of its own besides the
    defaults its Provider makes by itself (global_replica.is_system_default):
    habits, knowledge, FLAs the person hired. What a follower asks before it
    sets aside a graph it made itself (Node follower-runtime-prepare.js): a
    graph with any of them is the person's. Counted per label from the same
    read and classification an export of `global` makes; a copy of another
    computer's is not this computer's own, and the space itself is no record."""
    store._require_personal()
    space = await store.authorize(actor, personal_space_id, 'maintainer')
    async with store.runtime.driver.read_transaction() as transaction:
        read = await read_space(transaction, space)
    classification = read.classification
    selection = _select(classification, GLOBAL)
    counts = Counter(
        node.label for element, node in ((element, classification.nodes[element]) for element in selection.nodes)
        if element != classification.space_element_id and not is_copy(node.properties)
        and not is_system_default(node.label, node.properties, space['id'], store.settings.provider_id))
    return {'count': sum(counts.values()), 'labels': dict(sorted(counts.items()))}


# Reading ---------------------------------------------------------------------

@dataclass
class SpaceRead:
    """One personal space as the export read it: the classified records, and
    the nodes it met but did not read (their labels), and every relationship
    type it met, for what the envelope must say it left out."""
    classification: ScopeClassification
    unread: dict[str, tuple[str, ...]]
    relationship_types: set[str]


# A property list without the derived properties: vectors stay in Neo4j
# unless a scope's own records ask for them (_add_derived).
_PROPERTIES = '[key IN keys({0}) WHERE NOT key IN $derived | [key, {0}[key]]]'
# Recomputed records: nothing to count.
_NOT_OWNED = {label for label, rule in NODE_RULES.items() if rule.judge == ('fixed', DERIVED)}
_READ_LABELS = sorted({SPACE_LABEL, *(label for label, rule in NODE_RULES.items() if exported(rule))})


async def _rows(transaction, query, **parameters):
    result = await transaction.run(query, derived=sorted(DERIVED_PROPERTIES), **parameters)
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


async def read_space(transaction, space) -> SpaceRead:
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
    relationships, unread, types = [], {}, set()
    for starts in _chunks([space_element, *nodes]):
        for record in await _rows(transaction, f'''
            MATCH (start)-[relationship]->(end) WHERE elementId(start) IN $starts
            RETURN elementId(relationship) AS element_id, type(relationship) AS type,
                   elementId(start) AS start, elementId(end) AS end, labels(end) AS end_labels,
                   {_PROPERTIES.format('relationship')} AS properties
            ''', starts=starts):
            types.add(record['type'])
            if record['end'] in nodes or record['end'] == space_element:
                relationships.append(GraphRelationship(record['element_id'], record['type'], record['start'],
                                                       record['end'], dict(record['properties'])))
            else:
                unread[record['end']] = tuple(sorted(record['end_labels']))
        # Relationships into the space from a node no rule reads (local_only, or in no rule at all).
        for record in await _rows(transaction, '''
            MATCH (other)-[relationship]->(end) WHERE elementId(end) IN $starts
              AND NONE(label IN labels(other) WHERE label IN $read_labels)
            RETURN DISTINCT elementId(other) AS element_id, labels(other) AS labels, type(relationship) AS type
            ''', starts=starts, read_labels=_READ_LABELS):
            types.add(record['type'])
            unread[record['element_id']] = tuple(sorted(record['labels']))
    unread.update(await _owned_unread(transaction, space, conversations or {}))
    classification = ScopeClassification(space_element, nodes, relationships, conversations or {})
    return SpaceRead(classification, unread, types)


async def _owned_unread(transaction, space, conversations) -> dict[str, tuple[str, ...]]:
    """The space's nodes of a label no rule reads, found by the space's
    ownership properties, so a record with no relationship is not missed.
    db.labels() lists the labels in use; only labels outside the readable
    ones are scanned, each by its label, so with every label classified this
    costs one label scan per local_only label present and nothing else."""
    in_use = [record['label'] for record in await _rows(transaction, 'CALL db.labels() YIELD label RETURN label')]
    found = {}
    for label in sorted(set(in_use) - set(_READ_LABELS) - _NOT_OWNED):
        escaped = label.replace('`', '``')
        for record in await _rows(transaction, f'''
            MATCH (node:`{escaped}`)
            WHERE node.group_id = $group_id OR node.space_id = $space_id OR node.personal_space_id = $space_id
               OR node.space = $space_id OR node.scope IN $scopes
            RETURN elementId(node) AS element_id, labels(node) AS labels
            ''', group_id=space['group_id'], space_id=space['id'], scopes=sorted(conversations)):
            found[record['element_id']] = tuple(sorted(record['labels']))
    return found


def _conversations(space_id, nodes) -> dict:
    agents = {node.properties.get('agent_id') for node in nodes.values()
              if node.label in ('FuliProjectAgent', 'FuliProjectAgentAlias')} - {None}
    projects = {node.properties.get('project_id') for node in nodes.values()
                if node.label == 'FuliPersonalProject'} - {None}
    return conversation_scopes(space_id, sorted(agents), sorted(projects))


async def _found_rows(transaction, label, kind, found, space, space_element, nodes, conversations):
    returns = ('RETURN elementId(node) AS element_id, labels(node) AS labels, '
               f"{_PROPERTIES.format('node')} AS properties")
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


async def _add_derived(transaction, selection) -> None:
    """The second read, for an export with vectors: the derived properties of
    the scope's own records only."""
    nodes = {element: selection.classification.nodes[element] for element in selection.nodes}
    relationships = {relationship.element_id: relationship for relationship in selection.relationships}
    for records, match in ((nodes, 'MATCH (item) WHERE elementId(item) IN $elements'),
                           (relationships, 'MATCH ()-[item]->() WHERE elementId(item) IN $elements')):
        for chunk in _chunks(records):
            for row in await _rows(transaction, f'''
                {match}
                RETURN elementId(item) AS element_id,
                       [key IN $derived WHERE item[key] IS NOT NULL | [key, item[key]]] AS properties
                ''', elements=chunk):
                records[row['element_id']].properties.update(dict(row['properties']))


# The envelope ------------------------------------------------------------------

def encoded_value(value):
    """A property as JSON: a graph time keeps its type, a list its order. A
    datetime in a named zone keeps the name after its offset, as Neo4j writes
    it (`…+01:00[Europe/Berlin]`); UTC is an offset (the driver cannot tell the
    two apart)."""
    for kind, name in _TEMPORAL:
        if isinstance(value, kind):
            zone = zone_name(value) if kind is DateTime else None
            return {'$' + name: value.iso_format() + (f'[{zone}]' if zone else '')}
    if isinstance(value, (list, tuple)):
        return [encoded_value(item) for item in value]
    if isinstance(value, float) and not isfinite(value):
        return {'$float': repr(value)}
    return value


def zone_name(value) -> str | None:
    """The named time zone of a datetime (a pytz zone, as the driver reads it),
    or None for an offset."""
    zone = getattr(value.tzinfo, 'zone', None)
    return zone if isinstance(zone, str) and zone != 'UTC' else None


def encoded_properties(properties: dict) -> dict:
    return {key: encoded_value(properties[key]) for key in sorted(properties)}


def exported_properties(properties: dict) -> dict:
    """A record's properties as its owner has them: without this computer's
    copy marker (scope_import.py), so a copy exports what its owner does."""
    return encoded_properties({key: value for key, value in properties.items() if key not in REPLICA_FIELDS})


def is_copy(properties: dict) -> bool:
    """A record this computer keeps as a read-only copy (scope_import.py)."""
    return properties.get('fuli_replica_owner') is not None


def node_id(node: GraphNode) -> str | None:
    """Its key values, or None: a node without its key (an early record) has
    no identity another computer shares, so it is counted, never named."""
    values = [node.properties.get(key) for key in NODE_RULES[node.label].key]
    if any(value in (None, '') for value in values):
        return None
    return f'{node.label}:' + '/'.join(str(value) for value in values)


def _relationship_ids(relationships, node_ids) -> dict[str, str]:
    """Each relationship's ID: its own key where its type has one, else its
    type and ends; equal IDs are told apart by their properties' order (the
    #n suffix changes when those properties do: it is not a stable identity)."""
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
        group.sort(key=lambda item: canonical(exported_properties(item.properties)))
        for index, relationship in enumerate(group):
            ids[relationship.element_id] = f'{base}#{index}'
    return ids


def _home(scopes) -> str:
    """Where an importer finds a node this scope only points at."""
    return GLOBAL if GLOBAL in scopes else min(scopes)


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


@dataclass
class Selection:
    """One scope's nodes and relationships (by element ID) out of a space read."""
    classification: ScopeClassification
    nodes: set[str]
    relationships: list[GraphRelationship]


def _select(classification: ScopeClassification, scope) -> Selection:
    nodes = classification.nodes
    return Selection(
        classification,
        {element for element in nodes if scope in classification.node_scopes(element)},
        [relationship for relationship in classification.relationships
         if scope in classification.relationship_scopes(relationship)])


def _owned_here(selection: Selection, scope) -> None:
    """Only the owner exports a scope: a copy of this scope here refuses the
    export, and a copy of another scope is left out of it (it is reached as an
    external reference). The selection keeps this computer's own records."""
    nodes = selection.classification.nodes
    properties = [nodes[element].properties for element in selection.nodes]
    properties += [relationship.properties for relationship in selection.relationships]
    owners = sorted({item['fuli_replica_owner'] for item in properties
                     if is_copy(item) and scope in (item.get('fuli_replica_scopes') or ())})
    if owners:
        raise HTTPException(status_code=409, detail={
            'code': 'scope_not_owned_here', 'owner': owners[0],
            'message': f'This computer keeps {scope} as a read-only copy of computer {owners[0][:16]}; '
                       'only that computer exports it.'})
    selection.nodes = {element for element in selection.nodes if not is_copy(nodes[element].properties)}
    selection.relationships = [item for item in selection.relationships if not is_copy(item.properties)]


def _left_out(read: SpaceRead) -> tuple[dict, dict]:
    """The space's nodes in no rule (per label), and its local_only records
    (per label, no content): neither is exported."""
    unclassified, local_only = Counter(), Counter()
    for labels in read.unread.values():
        known = [label for label in labels if label in NODE_RULES]
        if not known:
            unclassified.update(labels)
        elif any(NODE_RULES[label].judge == ('fixed', LOCAL_ONLY) for label in known):
            local_only[min(label for label in known if NODE_RULES[label].judge == ('fixed', LOCAL_ONLY))] += 1
    classification = read.classification
    for element, node in classification.nodes.items():
        if LOCAL_ONLY in classification.node_scopes(element):
            local_only[node.label] += 1  # a conversation of a journal no pair explains, and what is under it
    return dict(unclassified), dict(local_only)


def _envelope(space, scope, read: SpaceRead, selection: Selection, *, vectors, embedding_model) -> dict:
    classification = read.classification
    nodes = classification.nodes
    node_ids = {element: node_id(node) for element, node in nodes.items()}
    # Two records under one ID (a key without a uniqueness constraint): neither has an identity to copy.
    shared = {value for value, count in Counter(node_ids.values()).items() if value and count > 1}
    node_ids = {element: None if value in shared else value for element, value in node_ids.items()}
    node_ids[classification.space_element_id] = f'{SPACE_LABEL}:{space["id"]}'
    named = [relationship for relationship in classification.relationships
             if node_ids.get(relationship.start) and node_ids.get(relationship.end)]
    relationship_ids = _relationship_ids(named, node_ids)
    relationship_scopes = {relationship.element_id: classification.relationship_scopes(relationship)
                           for relationship in classification.relationships}
    in_scope = selection.nodes
    unidentified = {element for element in in_scope if node_ids[element] is None}
    unidentified_relationships = Counter()
    chosen = []
    for relationship in selection.relationships:
        if relationship.element_id in relationship_ids:
            chosen.append(relationship)
        else:
            unidentified_relationships[relationship.type] += 1
            unidentified |= {end for end in (relationship.start, relationship.end) if node_ids.get(end) is None}
    external = {}
    for relationship in chosen:
        for end in (relationship.start, relationship.end):
            if end != classification.space_element_id and end not in in_scope:
                external[node_ids[end]] = _home(classification.node_scopes(end))
    for element in in_scope - unidentified:
        for reference in classification.references.get(element, ()):
            if reference in nodes and reference not in in_scope:
                if node_ids[reference] is None:
                    unidentified.add(reference)
                else:
                    external[node_ids[reference]] = _home(classification.node_scopes(reference))
            elif reference in relationship_scopes and scope not in relationship_scopes[reference]:
                if reference in relationship_ids:
                    external[relationship_ids[reference]] = _home(relationship_scopes[reference])
    node_entries = sorted(({
        'id': node_ids[element], 'labels': list(nodes[element].labels),
        'scopes': sorted(classification.node_scopes(element)),
        'properties': exported_properties(nodes[element].properties),
    } for element in in_scope - unidentified), key=lambda entry: entry['id'])
    relationship_entries = sorted(({
        'id': relationship_ids[relationship.element_id], 'type': relationship.type,
        'start': node_ids[relationship.start], 'end': node_ids[relationship.end],
        'scopes': sorted(relationship_scopes[relationship.element_id]),
        'properties': exported_properties(relationship.properties),
    } for relationship in chosen), key=lambda entry: entry['id'])
    unclassified_labels, local_only = _left_out(read)
    left_out = {
        'unclassifiedLabels': unclassified_labels,
        'unclassifiedRelationshipTypes': sorted(read.relationship_types - set(RELATIONSHIP_RULES)),
        'unidentifiedNodes': dict(Counter(nodes[element].label for element in unidentified)),
        'unidentifiedRelationships': dict(unidentified_relationships),
    }
    body = {
        'replicaProtocol': REPLICA_PROTOCOL, 'graphFormat': GRAPH_FORMAT_VERSION,
        'embeddingModel': embedding_model, 'vectors': vectors,
        'spaceId': space['id'], 'groupId': space['group_id'], 'scope': scope,
        'nodes': node_entries, 'relationships': relationship_entries,
        'ids': {'nodes': [entry['id'] for entry in node_entries],
                'relationships': [entry['id'] for entry in relationship_entries]},
        'externalRefs': [{'id': ref, 'scope': external[ref]} for ref in sorted(external)],
        **left_out, 'complete': not any(left_out.values()),
    }
    return {**body, 'localOnlyCount': local_only, 'exportedAt': now_utc().isoformat(),
            'digest': envelope_digest(body)}


def content_digest(nodes, relationships) -> str:
    """The SHA-256 of a copy's content as its owner wrote it: each node as
    (export ID, labels, properties) and each relationship as (type, start ID,
    end ID, properties), without the derived properties a computer computes for
    itself and without the copy marker. The same for an envelope's records
    (scope_import.py answers it for what it wrote) and for the copy in a graph
    (scope_replica_summary.py), so a copy changed here shows as a different
    digest. A relationship is named by its ends, not by its export ID: the #n
    that tells equal IDs apart depends on records a copy may not hold."""
    def kept(properties):
        return encoded_properties({key: value for key, value in properties.items()
                                   if key not in DERIVED_PROPERTIES and key not in REPLICA_FIELDS})
    return sha256_text(canonical({
        'nodes': sorted(canonical([node_id, sorted(labels), kept(properties)])
                        for node_id, labels, properties in nodes),
        'relationships': sorted(canonical([kind, start, end, kept(properties)])
                                for kind, start, end, properties in relationships),
    }))


def envelope_digest(envelope: dict) -> str:
    """The SHA-256 of everything but what the digest does not cover."""
    return sha256_text(canonical({key: value for key, value in envelope.items() if key not in _NOT_DIGESTED}))


def register_scope_export_route(application, store, Actor) -> None:
    # Read only, but it gives a whole scope at once: the console's own process
    # asks for it with the Provider's access token; no Agent tool reaches it.
    @application.post('/v1/scopes/export')
    async def scope_export(request: ScopeExportRequest, actor: Actor) -> Response:
        envelope = await export_scope(store, actor, request)
        return Response(content=canonical(envelope), media_type='application/json')

    @application.get('/v1/scopes/own-project-catalog')
    async def own_project_catalog(personal_space_id: str, actor: Actor, enrollment: bool = False) -> dict:
        store._require_personal()
        await store.authorize(actor, personal_space_id, 'maintainer')
        from contextlib import nullcontext
        from .project_installation import installation
        admission = installation(store.settings, inspecting=True) if enrollment else nullcontext((None, None))
        with admission as (_, state):
            if enrollment and (not state or state.get('spaceId', personal_space_id) != personal_space_id):
                raise HTTPException(409, detail={'code': 'project_installation_unavailable'})
            async with store.runtime.driver.read_transaction() as transaction:
                result = await transaction.run("""
                    MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->(p:FuliPersonalProject)
                    WHERE p.fuli_replica_owner IS NULL AND size(coalesce(p.fuli_replica_scopes, [])) = 0
                    RETURN p.project_id AS id ORDER BY id LIMIT 4097
                """, space=personal_space_id)
                ids = [row['id'] async for row in result]
            if len(ids) > 4096 or not all(isinstance(value, str) and value for value in ids):
                raise HTTPException(409, detail={'code': 'inventory_incomplete'})
            result = {'count': len(ids), 'digest': sha256_text(canonical(sorted(ids)))}
            if enrollment:
                result.update(projects=ids, installation=state)
        return result

    # A count only, for this computer's own process; no Agent tool reaches it.
    @application.get('/v1/scopes/global/own-records')
    async def scope_global_own_records(personal_space_id: str, actor: Actor) -> dict:
        return await own_global_records(store, actor, personal_space_id)
