"""Bring one scope's envelope into this graph as a read-only copy of another
computer's scope (docs/runner-roles-design.md, "Scopes in the graph",
"Import").

The owner computer writes the scope; this computer only brings its copy up
to date with the owner's export, under the same IDs, and never writes the
copy otherwise. Every record the import writes carries the copy marker
(graph_field_contract.REPLICA_FIELDS): the scopes it was copied for, the
owner (the certificate fingerprint its pairing pinned), when the import last
wrote it, and, for a record the owner no longer has while a record of this
computer still points at it, when that was found.

Nothing is written unless the whole envelope passes: its protocol, digest,
completeness and graph format (check_envelope), then, in the write
transaction, its space, and that it would land neither on this computer's
own records nor on a record a project of another owner shares (_Local).

One write transaction does the rest, so an import lands whole or not at all:
it reads the space as the export does, upserts nodes by their keys and
relationships by their identity (a relationship type with its own key by
that key; any other type as the whole group of that type between the same
two nodes, which the owner's group replaces), hangs imported task contexts
under one finished session per owner, and only after every upsert removes
what the owner no longer has. Importing the same envelope twice changes
nothing the second time.
"""
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Annotated, Any

import pytz
from fastapi import HTTPException, Query, Request
from neo4j.time import Date, DateTime, Duration, Time
from pydantic import BaseModel, ConfigDict, Field

from .graph_field_contract import NODE_FIELDS, RELATIONSHIP_FIELDS, REPLICA_FIELDS, StoredFieldError
from .graph_field_contract import carried_fields, stored_fields
from .graph_format_migrations import GRAPH_FORMAT_VERSION
from .model_base import StrictModel
from .provider_values import graphiti_group_id, now_utc, stable_uuid
from .runtime import LocalHashEmbedder
from .scope_classifier import (
    NODE_RULES, PROJECT_PREFIX, RELATIONSHIP_KEYS, SPACE_LABEL, GraphRelationship, exported,
)
from .scope_export import (
    REPLICA_PROTOCOL, canonical, encoded_properties, envelope_digest, node_id, read_space,
)

OWNER, OWNER_DELETED_AT, SCOPES, SYNCED_AT = (
    'fuli_replica_owner', 'fuli_replica_owner_deleted_at', 'fuli_replica_scopes', 'fuli_replica_synced_at')
# Rows one write query carries.
BATCH = 1000
# Dangling references named in a result; the count is always whole.
NAMED_DANGLING = 50
_LEFT_OUT = ('unclassifiedLabels', 'unclassifiedRelationshipTypes', 'unidentifiedNodes', 'unidentifiedRelationships')


def _datetime(text: str) -> DateTime:
    """`…+01:00[Europe/Berlin]` (scope_export.encoded_value) back in its named zone."""
    text, _, zone = text.partition('[')
    value = DateTime.from_iso_format(text)
    if not zone:
        return value
    try:
        # pytz, as the driver reads a named zone: a zoneinfo zone cannot give
        # the offset of the driver's own datetime type.
        return value.astimezone(pytz.timezone(zone.removesuffix(']')))
    except (pytz.UnknownTimeZoneError, ValueError) as error:
        raise ValueError(f'unknown time zone {zone!r}') from error


_RESTORE = {'$datetime': _datetime, '$date': Date.from_iso_format, '$time': Time.from_iso_format,
            '$duration': Duration.from_iso_format, '$float': float}
# The vectors this Provider's own embedder computes, from the text beside them (store_knowledge.py).
_EMBEDDED = {'Entity': ('name', 'name_embedding'), 'RELATES_TO': ('fact', 'fact_embedding')}
_SEMANTIC = ('fuli_semantic_vector', 'fuli_semantic_model', 'fuli_semantic_hash')
_SESSION = 'FuliTaskContextSession'
_COUNTS = ('created', 'updated', 'unchanged', 'deleted')


OWNER_PATTERN = r'^[0-9a-f]{64}$'


class ScopeImportRequest(StrictModel):
    # The owner computer: the certificate fingerprint its pairing pinned.
    owner: str = Field(pattern=OWNER_PATTERN)
    envelope: dict[str, Any]


class _Entry(BaseModel):
    # Values exactly as exported: no whitespace stripping, nothing extra.
    model_config = ConfigDict(extra='forbid')
    id: str
    scopes: list[str]
    properties: dict[str, Any]


class _Node(_Entry):
    labels: list[str]


class _Relationship(_Entry):
    type: str
    start: str
    end: str


class _Reference(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    scope: str


class _Envelope(BaseModel):
    model_config = ConfigDict(extra='ignore')
    embeddingModel: str | None
    vectors: bool
    spaceId: str
    groupId: str
    scope: str = Field(pattern=r'^(global|project:\S+)$')
    nodes: list[_Node]
    relationships: list[_Relationship]
    externalRefs: list[_Reference]
    digest: str


def _refuse(status: int, code: str, message: str, **detail):
    raise HTTPException(status_code=status, detail={'code': code, 'message': message, **detail})


def check_envelope(envelope: dict) -> _Envelope:
    """What the envelope alone decides: refused before anything is read."""
    protocol = envelope.get('replicaProtocol')
    if protocol != REPLICA_PROTOCOL:
        _refuse(422, 'replica_protocol_unknown',
                f'This FULI reads copy protocol {REPLICA_PROTOCOL}; the envelope is {protocol!r}. '
                'Nothing was written.')
    try:
        digest = envelope_digest(envelope)
    except (TypeError, ValueError):
        digest = None
    if digest is None or digest != envelope.get('digest'):
        _refuse(422, 'replica_digest_mismatch',
                'The envelope does not match its digest, so it changed after it was exported. Nothing was written.')
    if envelope.get('complete') is not True:
        left = {name: envelope.get(name) for name in _LEFT_OUT if envelope.get(name)}
        _refuse(422, 'replica_envelope_incomplete',
                'The export left records out, so it cannot be a copy. Nothing was written.', leftOut=left)
    if envelope.get('graphFormat') != GRAPH_FORMAT_VERSION:
        _refuse(409, 'replica_format_mismatch',
                f"The envelope is graph format {envelope.get('graphFormat')!r} and this graph is "
                f'{GRAPH_FORMAT_VERSION}. A copy is never upgraded here: bring both FULIs to the same version. '
                'Nothing was written.')
    try:
        return _Envelope.model_validate(envelope)
    except ValueError as error:
        _refuse(422, 'replica_envelope_invalid', f'The envelope is not a scope export: {error}. Nothing was written.')


async def import_scope(store, actor, request: ScopeImportRequest) -> dict:
    store._require_personal()
    envelope = check_envelope(request.envelope)
    space = await _local_space(store, actor, envelope)
    plan = await _plan(store, envelope)
    async with store.runtime.driver.transaction() as transaction:
        read = await read_space(transaction, space)
        local = _Local(read, space, envelope, request.owner)
        local.check(plan)
        result = await _Writer(transaction, local, plan, request.owner, now_utc()).run()
    return result


async def _local_space(store, actor, envelope: _Envelope) -> dict:
    """The personal space the envelope names must be this computer's, under
    the same group ID: an ID computed here then names the same record."""
    group = graphiti_group_id(store.settings.provider_id, 'personal', envelope.spaceId)
    rows, _, _ = await store.runtime.driver.execute_query(
        "MATCH (space:FuliSpace {id: $id, kind: 'personal'}) RETURN space.group_id AS group_id",
        id=envelope.spaceId, routing_='r')
    if group != envelope.groupId or not rows or rows[0]['group_id'] != envelope.groupId:
        _refuse(409, 'replica_space_mismatch',
                'This computer has no personal space with the ID and group of the envelope. A copy lands only in '
                "the owner's own space, so this computer must use the owner's space ID first. Nothing was written.")
    space = await store.authorize(actor, envelope.spaceId, 'maintainer')
    return {'id': space['id'], 'group_id': space['group_id']}


# What the envelope asks for ----------------------------------------------------

@dataclass
class _Record:
    id: str
    owner: str  # label or relationship type: its field contract
    labels: tuple[str, ...]
    content: dict  # properties as the owner has them, graph types restored
    scopes: list[str]
    start: str | None = None
    end: str | None = None

    @property
    def identity(self):
        """A node's export ID; a relationship's own key, else (type, start,
        end): the #n suffix that tells such relationships apart is not an
        identity, so they are one group."""
        if self.start is None:
            return self.id
        key = self.content.get(RELATIONSHIP_KEYS.get(self.owner, ''))
        return f'{self.owner}:{key}' if key else (self.owner, self.start, self.end)


@dataclass
class _Plan:
    envelope: _Envelope
    nodes: list[_Record]
    relationships: list[_Record]
    # Properties the field contract does not declare ('Label.property'):
    # carried as they are, as carried_fields copies a stored record.
    carried: Counter


def _restored(value):
    if isinstance(value, dict):
        if len(value) == 1 and next(iter(value)) in _RESTORE:
            tag, text = next(iter(value.items()))
            return _RESTORE[tag](text)
        raise ValueError(f'a property value is a map {sorted(value)}')
    if isinstance(value, list):
        return [_restored(item) for item in value]
    return value


async def _plan(store, envelope: _Envelope) -> _Plan:
    own_model = f'{LocalHashEmbedder.version}/{store.settings.embedding_dim}'
    own_vectors = envelope.vectors and envelope.embeddingModel == own_model
    nodes, relationships = [], []
    for entry in envelope.nodes:
        label = entry.id.split(':', 1)[0]
        rule = NODE_RULES.get(label)
        if rule is None or not exported(rule) or label not in entry.labels:
            _refuse(422, 'replica_envelope_invalid',
                    f'{entry.id} is not a record this FULI copies. Nothing was written.')
        nodes.append(_Record(entry.id, label, tuple(sorted(entry.labels)), _content(entry), entry.scopes))
    for entry in envelope.relationships:
        relationships.append(_Record(entry.id, entry.type, (), _content(entry), entry.scopes, entry.start, entry.end))
    named = Counter(record.id for record in nodes)
    if any(count > 1 for count in named.values()):
        _refuse(422, 'replica_envelope_invalid', f'The envelope names {max(named, key=named.get)} twice. '
                'Nothing was written.')
    if not own_vectors:
        await _embed(store, [*nodes, *relationships])
    carried = Counter()
    for record in [*nodes, *relationships]:
        fields = (NODE_FIELDS if record.start is None else RELATIONSHIP_FIELDS).get(record.owner, {})
        try:
            stored_fields(record.owner, {key: value for key, value in record.content.items() if key in fields})
        except StoredFieldError as error:
            _refuse(422, 'replica_field_contract', f'{record.id}: {error}. Nothing was written.')
        carried.update(f'{record.owner}.{key}' for key in record.content if key not in fields)
    return _Plan(envelope, nodes, relationships, carried)


def _content(entry: _Entry) -> dict:
    marked = sorted(set(entry.properties) & set(REPLICA_FIELDS))
    if marked:
        _refuse(422, 'replica_envelope_invalid', f'{entry.id} carries the copy marker {", ".join(marked)}, which only '
                'this computer writes. Nothing was written.', record=entry.id, properties=marked)
    try:
        return {key: _restored(value) for key, value in entry.properties.items()}
    except ValueError as error:
        _refuse(422, 'replica_envelope_invalid', f'{entry.id}: {error}. Nothing was written.')


async def _embed(store, records) -> None:
    """The owner's vectors of another model (or none) are dropped, and this
    computer's own embedder computes them from the same text, as its own
    write path does. fuli_semantic_* is kept: it names its model on the item,
    and the meaning index (knowledge_semantic_index.py) recomputes any item
    whose model or text hash is not this computer's."""
    embedded = [(record, *_EMBEDDED[record.owner]) for record in records if record.owner in _EMBEDDED]
    for record, _, vector in embedded:
        record.content.pop(vector, None)
    texts = [(record, vector, record.content[text]) for record, text, vector in embedded
             if isinstance(record.content.get(text), str)]
    for start in range(0, len(texts), BATCH):
        chunk = texts[start:start + BATCH]
        for (record, vector, _), values in zip(chunk, await store.runtime.embedder.create_batch(
                [text for _, _, text in chunk])):
            record.content[vector] = values


# What this computer has ----------------------------------------------------------

def _here(properties: dict) -> bool:
    return properties.get(OWNER) is None


def _compared(properties: dict) -> str:
    """A record's content as its owner has it, for telling whether it changed."""
    return canonical(encoded_properties({key: value for key, value in properties.items()
                                         if key not in REPLICA_FIELDS}))


class _Local:
    """This computer's space as the export reads it, indexed by export ID."""

    def __init__(self, read, space, envelope: _Envelope, owner: str):
        self.classification = read.classification
        self.space = space
        self.scope = envelope.scope
        self.owner = owner
        nodes = self.classification.nodes
        self.ids = {element: node_id(node) for element, node in nodes.items()}
        self.ids[self.classification.space_element_id] = f'{SPACE_LABEL}:{space["id"]}'
        self.elements = {node: element for element, node in self.ids.items() if node}
        self.relationships = defaultdict(list)
        for relationship in self.classification.relationships:
            identity = self.identity(relationship)
            if identity is not None:
                self.relationships[identity].append(relationship)
        # Who writes each project this computer knows: '' this computer, else the copy's owner.
        self.project_owners = {node.properties.get('project_id'): node.properties.get(OWNER) or ''
                               for node in nodes.values() if node.label == 'FuliPersonalProject'}

    def properties(self, element: str) -> dict:
        return self.classification.nodes[element].properties

    def identity(self, relationship: GraphRelationship):
        start, end = self.ids.get(relationship.start), self.ids.get(relationship.end)
        if start is None or end is None:
            return None
        key = relationship.properties.get(RELATIONSHIP_KEYS.get(relationship.type, ''))
        return f'{relationship.type}:{key}' if key else (relationship.type, start, end)

    def check(self, plan: _Plan) -> None:
        self._not_owned_here(plan)
        self._same_owner()
        self._one_owner(plan)

    def _not_owned_here(self, plan: _Plan) -> None:
        """A copy never covers this computer's own records: the scope is this
        computer's when one of its own records has an ID the envelope names,
        or belongs to the scope alone."""
        mine = [record.id for record in plan.nodes
                if record.id in self.elements and _here(self.properties(self.elements[record.id]))]
        mine += [record.id for record in plan.relationships if isinstance(record.identity, str)
                 and any(_here(local.properties) for local in self.relationships.get(record.identity, ()))]
        classification = self.classification
        mine += sorted(self.ids[element] or element for element, node in classification.nodes.items()
                       if _here(node.properties) and classification.node_scopes(element) == {self.scope})
        if mine:
            mine = sorted(set(mine))
            _refuse(409, 'replica_scope_owned_here',
                    f'This computer writes {self.scope} itself: {len(mine)} of its own records belong to it. '
                    'A copy never covers them; route the scope to one owner first. Nothing was written.',
                    count=len(mine), records=mine[:5])

    def _same_owner(self) -> None:
        """A copy of this scope stays with the owner it came from: an envelope
        of another owner is refused, not taken over (a handover is a later,
        explicit step)."""
        classification = self.classification
        held = [node.properties for node in classification.nodes.values()]
        held += [relationship.properties for relationship in classification.relationships]
        owners = sorted({item[OWNER] for item in held if not _here(item) and item[OWNER] != self.owner
                         and self.scope in (item.get(SCOPES) or ())})
        if owners:
            _refuse(409, 'replica_owner_changed',
                    f'This computer keeps {self.scope} as a copy of computer {owners[0][:16]}, not of this '
                    'envelope\'s owner. A copy is never handed to another owner by an import. Nothing was written.',
                    scope=self.scope, owner=owners[0])

    def _owner_of(self, scope: str) -> str | None:
        """'' when this computer writes the project, the copy's owner, or None when unknown here."""
        if not scope.startswith(PROJECT_PREFIX):
            return None
        return self.project_owners.get(scope.removeprefix(PROJECT_PREFIX))

    def _one_owner(self, plan: _Plan) -> None:
        """A record in this scope and in a project of another owner, or a
        project relation to a project of another owner, is refused: one
        owner writes every scope a record is in (§12, items 5 and 6). A
        project relation is in both projects, so it is named first by its own
        code."""
        self._related_projects(plan)
        for record in [*plan.nodes, *plan.relationships]:
            for other in record.scopes:
                found = self._owner_of(other) if other != self.scope else None
                if found is not None and found != self.owner:
                    self._other_owner('replica_cross_owner_record', record.id, other, found)
            element = self.elements.get(record.id)
            if element is not None and not _here(self.properties(element)):
                held = self.properties(element)
                kept = set(held.get(SCOPES) or ()) - {self.scope}
                if held[OWNER] != self.owner and kept:
                    self._other_owner('replica_cross_owner_record', record.id, min(kept), held[OWNER])

    def _related_projects(self, plan: _Plan) -> None:
        copied = {record.id for record in plan.nodes}
        for record in plan.relationships:
            if record.owner != 'PERSONAL_PROJECT_RELATION':
                continue
            for end in (record.start, record.end):
                element = self.elements.get(end)
                if end not in copied and element is not None:
                    found = self.properties(element).get(OWNER) or ''
                    if found != self.owner:
                        self._other_owner('replica_related_project_owner', record.id,
                                          f"project:{self.properties(element).get('project_id')}", found)

    def _other_owner(self, code, record_id, scope, owner) -> None:
        who = 'this computer' if owner == '' else f'computer {owner[:16]}'
        _refuse(409, code, f'{record_id} is also in {scope}, which {who} writes. One owner writes every scope '
                'a record is in, so this envelope cannot be copied here. Nothing was written.',
                record=record_id, scope=scope)


# Writing ---------------------------------------------------------------------------

async def _run(transaction, query: str, **parameters) -> list:
    """Every write of an import goes through here (a test fails one midway)."""
    result = await transaction.run(query, **parameters)
    return [record async for record in result]


def _batches(rows):
    for start in range(0, len(rows), BATCH):
        yield rows[start:start + BATCH]


def _label_text(labels) -> str:
    return ':'.join(f"`{label.replace('`', '``')}`" for label in labels)


class _Writer:
    def __init__(self, transaction, local: _Local, plan: _Plan, owner: str, now):
        self.transaction = transaction
        self.local = local
        self.plan = plan
        self.scope = plan.envelope.scope
        self.owner = owner
        self.now = DateTime.from_native(now)
        self.nodes = Counter()
        self.relationships = Counter()
        self.dangling = []
        self.written = {}  # envelope node ID -> element ID here

    async def run(self) -> dict:
        await self._nodes()
        kept = await self._relationships()
        await self._task_contexts()
        await self._removed(kept)
        return {
            'scope': self.scope, 'owner': self.owner, 'syncedAt': self.now.iso_format(),
            'digest': self.plan.envelope.digest,
            'nodes': {name: self.nodes[name] for name in (*_COUNTS, 'ownerDeleted')},
            'relationships': {name: self.relationships[name] for name in _COUNTS},
            'dangling': {'count': len(self.dangling), 'relationships': self.dangling[:NAMED_DANGLING]},
            'undeclaredProperties': dict(sorted(self.plan.carried.items())),
        }

    def _marker(self, held: dict | None) -> dict:
        """Only this computer writes the marker: an owner-deleted mark goes
        when the owner has the record again."""
        scopes = sorted({*((held or {}).get(SCOPES) or ()), self.scope})
        return {SCOPES: scopes, OWNER: self.owner, SYNCED_AT: self.now}

    def _current(self, held: dict | None) -> bool:
        """Its marker says: this owner's copy, of this scope, not deleted by the owner."""
        return (held is not None and held.get(OWNER) == self.owner and held.get(OWNER_DELETED_AT) is None
                and self.scope in (held.get(SCOPES) or ()))

    def _same(self, content: dict, held: dict | None, labels, held_labels) -> bool:
        return self._current(held) and labels == held_labels and _compared(content) == _compared(held)

    async def _held(self, query: str, elements) -> dict:
        found = {}
        for chunk in _batches(sorted(elements)):
            for row in await _run(self.transaction, query, elements=chunk):
                found[row['element']] = (dict(row['properties']), tuple(sorted(row.get('labels') or ())))
        return found

    # Nodes ---------------------------------------------------------------------

    async def _nodes(self) -> None:
        local = self.local
        matched = {record.id: local.elements[record.id] for record in self.plan.nodes if record.id in local.elements}
        held = await self._held('''
            UNWIND $elements AS element MATCH (node) WHERE elementId(node) = element
            RETURN element, properties(node) AS properties, labels(node) AS labels''', matched.values())
        await self._unread_namesakes()
        created, updated = defaultdict(list), []
        for record in self.plan.nodes:
            element = matched.get(record.id)
            properties, labels = held.get(element, (None, None))
            content = self._kept_semantic(record.content, properties)
            if self._same(content, properties, record.labels, labels):
                self.nodes['unchanged'] += 1
                self.written[record.id] = element
                continue
            row = {'id': record.id, 'properties': self._fields(record.owner, content, properties)}
            if element is None:
                created[record.labels].append(row)
            else:
                updated.append({**row, 'element': element, 'add': sorted(set(record.labels) - set(labels)),
                                'drop': sorted(set(labels) - set(record.labels))})
                self.written[record.id] = element
        for labels, rows in created.items():
            for chunk in _batches(rows):
                for row in await _run(self.transaction, f'''
                        UNWIND $rows AS row CREATE (node:{_label_text(labels)}) SET node = row.properties
                        RETURN row.id AS id, elementId(node) AS element''', rows=chunk):
                    self.written[row['id']] = row['element']
            self.nodes['created'] += len(rows)
        for chunk in _batches(updated):
            await _run(self.transaction, '''
                UNWIND $rows AS row MATCH (node) WHERE elementId(node) = row.element
                SET node = row.properties''', rows=chunk)
        for row in updated:
            for change, labels in (('SET', row['add']), ('REMOVE', row['drop'])):
                if labels:
                    await _run(self.transaction, f'MATCH (node) WHERE elementId(node) = $element '
                               f'{change} node:{_label_text(labels)}', element=row['element'])
        self.nodes['updated'] += len(updated)

    async def _unread_namesakes(self) -> None:
        """A record of the envelope's key that the space read did not reach
        (another space's, or cut off from this one) is never overwritten or
        duplicated."""
        keys = defaultdict(list)
        for record in self.plan.nodes:
            if record.id not in self.local.elements:
                keys[record.owner].append({key: record.content.get(key) for key in NODE_RULES[record.owner].key})
        for label, rows in keys.items():
            match = ', '.join(f'{key}: row.{key}' for key in NODE_RULES[label].key)
            for chunk in _batches(rows):
                found = await _run(self.transaction, f'''
                    UNWIND $rows AS row MATCH (node:{_label_text([label])} {{{match}}})
                    RETURN count(node) AS count''', rows=chunk)
                if found and found[0]['count']:
                    _refuse(409, 'replica_record_conflict',
                            f'This graph already has a {label} with a key the envelope names, outside this personal '
                            'space. Nothing was written.')

    @staticmethod
    def _kept_semantic(content: dict, held: dict | None) -> dict:
        """An envelope without vectors leaves the meaning vector this computer
        computed in place; the meaning index recomputes it when its text changed."""
        if held is None or any(name in content for name in _SEMANTIC):
            return content
        return {**content, **{name: held[name] for name in _SEMANTIC if name in held}}

    def _fields(self, owner: str, content: dict, held: dict | None) -> dict:
        record, _ = carried_fields(owner, {key: value for key, value in content.items() if key not in REPLICA_FIELDS},
                                   self._marker(held))
        return record

    # Relationships -----------------------------------------------------------------

    def _end(self, export_id: str) -> str | None:
        return self.written.get(export_id) or self.local.elements.get(export_id)

    async def _relationships(self) -> set[str]:
        """Writes the envelope's relationships; returns the elements of this
        computer's copies it kept or replaced, so none is released again."""
        local = self.local
        wanted = defaultdict(list)
        for record in self.plan.relationships:
            ends = [self._end(record.start), self._end(record.end)]
            if None in ends:
                missing = [ref for ref, element in zip((record.start, record.end), ends) if element is None]
                self.dangling.append({'id': record.id, 'missing': missing})
                continue
            wanted[record.identity].append((record, *ends))
        copies = {identity: [item for item in local.relationships.get(identity, ()) if not _here(item.properties)]
                  for identity in wanted}
        held = await self._held('''
            UNWIND $elements AS element MATCH ()-[link]->() WHERE elementId(link) = element
            RETURN element, properties(link) AS properties''',
            [item.element_id for items in copies.values() for item in items])
        kept, created, updated, removed = set(), defaultdict(list), [], []
        for identity, records in wanted.items():
            existing = copies[identity]
            # Keyed: one record, whose ends may have moved. Grouped: the owner's group replaces the copy's.
            same_ends = all((item.start, item.end) == (records[0][1], records[0][2]) for item in existing)
            if (existing and same_ends and all(self._current(held[item.element_id][0]) for item in existing)
                    and sorted(_compared(record.content) for record, _, _ in records)
                    == sorted(_compared(held[item.element_id][0]) for item in existing)):
                kept |= {item.element_id for item in existing}
                self.relationships['unchanged'] += len(records)
                continue
            scopes = {SCOPES: sorted({scope for item in existing
                                      for scope in held[item.element_id][0].get(SCOPES) or ()})}
            if existing and same_ends and len(existing) == len(records) == 1:
                record = records[0][0]
                kept.add(existing[0].element_id)
                updated.append({'element': existing[0].element_id,
                                'properties': self._fields(record.owner, record.content, scopes)})
                self.relationships['updated'] += 1
                continue
            removed += [item.element_id for item in existing]
            for record, start, end in records:
                created[record.owner].append({'start': start, 'end': end,
                                              'properties': self._fields(record.owner, record.content, scopes)})
            self.relationships['updated' if existing else 'created'] += len(records)
        for chunk in _batches(removed):
            await _run(self.transaction, '''
                UNWIND $elements AS element MATCH ()-[link]->() WHERE elementId(link) = element DELETE link''',
                elements=chunk)
        for chunk in _batches(updated):
            await _run(self.transaction, '''
                UNWIND $rows AS row MATCH ()-[link]->() WHERE elementId(link) = row.element
                SET link = row.properties''', rows=chunk)
        for kind, rows in created.items():
            for chunk in _batches(rows):
                await _run(self.transaction, f'''
                    UNWIND $rows AS row
                    MATCH (start) WHERE elementId(start) = row.start
                    MATCH (end) WHERE elementId(end) = row.end
                    CREATE (start)-[link:{_label_text([kind])}]->(end) SET link = row.properties''', rows=chunk)
        return kept | set(removed)

    # Task contexts -------------------------------------------------------------

    async def _task_contexts(self) -> None:
        """Task contexts are reached through a client session, which stays on
        the computer it ran on (local_only). Imported ones hang under one
        session per owner that has no current task, so they read as finished
        history and their tokens are never accepted here
        (store_task_contexts.get_task_context needs the session's current token)."""
        contexts = [self.written[record.id] for record in self.plan.nodes if record.owner == 'FuliTaskContext']
        if not contexts:
            return
        session_id = stable_uuid('fuli-replica-task-session', self.local.space['id'], self.owner)
        marker = {OWNER: self.owner, SYNCED_AT: self.now}
        found = await _run(self.transaction, '''
            MATCH (session:FuliTaskContextSession {id: $id})
            RETURN [(session)-[:HAS_CONTEXT]->(task) | elementId(task)] AS linked''', id=session_id)
        if not found:
            await _run(self.transaction, '''
                MATCH (space:FuliSpace {id: $space_id})
                CREATE (session:FuliTaskContextSession) SET session = $session
                CREATE (space)-[link:HAS_TASK_CONTEXT_SESSION]->(session) SET link = $link''',
                space_id=self.local.space['id'], link=stored_fields('HAS_TASK_CONTEXT_SESSION', dict(marker)),
                session=stored_fields(_SESSION, {'id': session_id, 'write_serial': 0, **marker}))
        linked = set(found[0]['linked']) if found else set()
        missing = sorted(set(contexts) - linked)
        for chunk in _batches(missing):
            await _run(self.transaction, '''
                MATCH (session:FuliTaskContextSession {id: $id})
                UNWIND $elements AS element MATCH (task) WHERE elementId(task) = element
                CREATE (session)-[link:HAS_CONTEXT]->(task) SET link = $link''',
                id=session_id, elements=chunk,
                link=stored_fields('HAS_CONTEXT', {**marker, SCOPES: [self.scope]}))

    # What the owner no longer has --------------------------------------------------

    def _mine(self, properties: dict) -> bool:
        """A copy of this scope from this envelope's owner: the only records an import releases."""
        return properties.get(OWNER) == self.owner and self.scope in (properties.get(SCOPES) or ())

    async def _removed(self, handled: set[str]) -> None:
        local = self.local
        classification = local.classification
        stale_links = [item for item in classification.relationships
                       if self._mine(item.properties) and item.element_id not in handled]
        await self._release({item.element_id: item.properties for item in stale_links}, relationship=True)
        wanted = {record.id for record in self.plan.nodes}
        stale = [element for element, node in classification.nodes.items()
                 if self._mine(node.properties) and local.ids[element] not in wanted]
        await self._release({element: classification.nodes[element].properties for element in stale},
                            relationship=False)
        # A finished session left with no task context goes with them.
        await _run(self.transaction, '''
            MATCH (session:FuliTaskContextSession {id: $id})
            WHERE NOT EXISTS { MATCH (session)-[:HAS_CONTEXT]->() } DETACH DELETE session''',
            id=stable_uuid('fuli-replica-task-session', local.space['id'], self.owner))

    async def _release(self, items: dict, *, relationship: bool) -> None:
        """Each copy the owner no longer has in this scope (element -> its
        properties): kept for its other scopes; a node this computer's own
        records still point at is kept and marked as deleted by its owner;
        anything else is deleted."""
        scope = self.scope
        reduced, deleted, marked = [], [], []
        anchored = set()
        if not relationship:
            for chunk in _batches(sorted(items)):
                anchored |= {row['element'] for row in await _run(self.transaction, '''
                    UNWIND $elements AS element MATCH (node) WHERE elementId(node) = element
                      AND EXISTS { MATCH (node)-[link]-() WHERE link.fuli_replica_owner IS NULL }
                    RETURN element''', elements=chunk)}
        for element, properties in sorted(items.items()):
            remaining = sorted(set(properties.get(SCOPES) or ()) - {scope})
            if remaining:
                reduced.append({'element': element, 'scopes': remaining})
            elif element in anchored:
                if properties.get(OWNER_DELETED_AT) is None:
                    marked.append(element)
            else:
                deleted.append(element)
        match = 'MATCH ()-[item]->()' if relationship else 'MATCH (item)'
        for chunk in _batches(reduced):
            await _run(self.transaction, f'''
                UNWIND $rows AS row {match} WHERE elementId(item) = row.element
                SET item.fuli_replica_scopes = row.scopes, item.fuli_replica_synced_at = $now''',
                rows=chunk, now=self.now)
        for chunk in _batches(marked):
            await _run(self.transaction, '''
                UNWIND $elements AS element MATCH (item) WHERE elementId(item) = element
                SET item.fuli_replica_owner_deleted_at = $now''', elements=chunk, now=self.now)
        for chunk in _batches(deleted):
            await _run(self.transaction, f'''
                UNWIND $elements AS element {match} WHERE elementId(item) = element
                {'DELETE' if relationship else 'DETACH DELETE'} item''', elements=chunk)
        counts = self.relationships if relationship else self.nodes
        counts['updated'] += len(reduced)
        counts['deleted'] += len(deleted)
        if not relationship:
            counts['ownerDeleted'] += len(marked)


def register_scope_import_route(application, store, Actor) -> None:
    # Writes a whole scope at once, for this computer's own process (a copy
    # being brought up to date, later a move): the Provider's access token,
    # no Agent tool reaches it, as the export.
    # The body is the envelope exactly as the export returned it (nothing
    # between the two computers parses and re-serializes it); `owner` is a
    # query parameter.
    @application.post('/v1/scopes/import')
    async def scope_import(request: Request, actor: Actor,
                           owner: Annotated[str, Query(pattern=OWNER_PATTERN)]) -> dict:
        try:
            envelope = json.loads(await request.body())
        except ValueError:
            envelope = None
        if not isinstance(envelope, dict):
            _refuse(422, 'replica_envelope_invalid', 'The body is not a JSON envelope. Nothing was written.')
        return await import_scope(store, actor, ScopeImportRequest(owner=owner, envelope=envelope))
