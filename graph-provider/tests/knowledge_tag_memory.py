"""An in-memory port of the tag vocabulary for the Provider route tests.

It keeps the Neo4j port's contract (store_knowledge_tags.py): one lock per
space under which the domain reads, decides and writes, reads that yield so
concurrent requests really interleave, versions that grow by one per write, and
nothing ever deleted. Cypher itself is covered by the *_neo4j.py tests.
"""
import asyncio
import copy
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException

from fuli_graph.config import Settings
from fuli_graph.knowledge_tag_routes import register_knowledge_tag_routes
from fuli_graph.name_identity import identity_key
from fuli_graph.runtime import LocalHashEmbedder

from knowledge_tag_scenarios import REVIEW_TOKEN

SPACE = 'synthetic-tag-space'
EMBEDDING_DIM = Settings.model_fields['embedding_dim'].default
THRESHOLD = Settings.model_fields['tag_similarity_threshold'].default
LIVE = ('provisional', 'active')


class MemoryTagReader:
    def __init__(self, vocabulary, space_id):
        self._vocabulary, self._space_id = vocabulary, space_id

    async def ranking_roots(self, namespaces, keys):
        return [copy.deepcopy(tag) for tag in self._vocabulary.in_space(
            self._space_id, namespaces, ('active', 'provisional', 'merged'))
            if tag['name_key'] in keys or set(tag['alias_keys']) & set(keys)]

    async def ranking_target(self, namespaces, tag_id):
        tag = await self.get_any(tag_id)
        return tag if tag and tag['namespace_key'] in namespaces else None

    async def ranking_neighbors(self, namespaces, root_ids):
        tags = self._vocabulary.in_space(self._space_id, namespaces, ('active',))
        roots = [tag for tag in tags if tag['id'] in root_ids]
        return [copy.deepcopy(tag) for tag in tags if any(
            root['id'] in tag.get('parent_ids', []) or root['id'] in tag.get('related_ids', [])
            or tag['id'] in root.get('related_ids', []) for root in roots)]

    async def ranking_links(self, tag_ids, kind, item_ids):
        return [link for link in await self.links_of(tag_ids)
                if link['space_id'] == self._space_id and link['item_kind'] == kind and link['item_id'] in item_ids]

    async def find_by_key(self, namespace_keys, key):
        return await self._by_key(namespace_keys, key, LIVE)

    async def find_redirects(self, namespace_keys, key):
        return await self._by_key(namespace_keys, key, ('merged',))

    async def _by_key(self, namespace_keys, key, statuses):
        await asyncio.sleep(0)
        return [copy.deepcopy(tag) for tag in self._vocabulary.in_space(self._space_id, namespace_keys, statuses)
                if tag['name_key'] == key or key in tag['alias_keys']]

    async def list_visible(self, namespace_keys, limit):
        await asyncio.sleep(0)
        return [copy.deepcopy(tag) for tag in self._vocabulary.in_space(self._space_id, namespace_keys)][:limit]

    async def get_any(self, tag_id):
        tag = self._vocabulary.tags.get(tag_id)
        return copy.deepcopy(tag) if tag and tag['space_id'] == self._space_id else None

    async def by_identity(self, namespace_key, name_key):
        return next((copy.deepcopy(tag) for tag in self._vocabulary.tags.values()
                     if (tag['namespace_key'], tag['name_key']) == (namespace_key, name_key)), None)

    async def all_tags(self):
        await asyncio.sleep(0)
        return [copy.deepcopy(tag) for tag in self._vocabulary.tags.values() if tag['space_id'] == self._space_id]

    async def links_by_ids(self, link_ids):
        return {link_id: dict(self._vocabulary.links[link_id]) for link_id in link_ids
                if link_id in self._vocabulary.links}

    async def links_of(self, tag_ids, limit=None):
        await asyncio.sleep(0)
        links = sorted((dict(link) for link in self._vocabulary.links.values()
                        if link['tag_id'] in tag_ids and link['status'] == 'attached'),
                       key=lambda link: (link['attached_at'], link['id']))
        return links[:limit] if limit else links

    async def links_moved_into(self, targets):
        wanted = {(target['tag_id'], target['item_kind'], target['item_id']) for target in targets}
        return [dict(link) for link in self._vocabulary.links.values() if link['status'] == 'moved'
                and (link.get('moved_to_tag_id'), link['item_kind'], link['item_id']) in wanted]

    async def link_counts(self, tag_ids):
        counts = {}
        for link in self._vocabulary.links.values():
            if link['tag_id'] in tag_ids and link['status'] == 'attached':
                counts[link['tag_id']] = counts.get(link['tag_id'], 0) + 1
        return counts

    async def attached_count(self, item_kind, item_id):
        return sum(1 for link in self._vocabulary.links.values() if link['status'] == 'attached'
                   and (link['item_kind'], link['item_id']) == (item_kind, item_id))

    async def item_tags(self, item_kind, item_id, namespace_keys):
        visible = {tag['id']: tag for tag in self._vocabulary.in_space(self._space_id, namespace_keys)}
        return sorted((copy.deepcopy(visible[link['tag_id']]) for link in self._vocabulary.links.values()
                       if link['status'] == 'attached' and link['tag_id'] in visible
                       and (link['item_kind'], link['item_id']) == (item_kind, item_id)),
                      key=lambda tag: tag['name_key'])

    async def revisions(self, tag_id, limit):
        mine = [dict(revision) for revision in self._vocabulary.revisions if revision['tag_id'] == tag_id]
        return list(reversed(mine))[:limit]

    async def operations(self, operation_ids):
        return {revision['operation_id']: dict(revision) for revision in self._vocabulary.revisions
                if revision.get('operation_id') in operation_ids and revision.get('snapshot_json')}

    async def merges_into(self, tag_id):
        return [dict(revision) for revision in reversed(self._vocabulary.revisions)
                if revision.get('action') == 'merge' and revision.get('related_tag_id') == tag_id
                and revision.get('snapshot_json')]

    async def undone(self, operation_ids):
        return {revision['undoes_operation_id'] for revision in self._vocabulary.revisions
                if revision.get('undoes_operation_id') in operation_ids}


class MemoryLockedVocabulary(MemoryTagReader):
    async def apply(self, *, new_tags=(), updates=(), links=(), revisions=()):
        await asyncio.sleep(0)
        vocabulary, written = self._vocabulary, {}
        for tag in new_tags:
            assert tag['id'] not in vocabulary.tags, 'the domain decided under the lock'
            assert not any((other['namespace_key'], other['name_key']) == (tag['namespace_key'], tag['name_key'])
                           for other in vocabulary.tags.values()), 'unique (space, namespace, name)'
            vocabulary.tags[tag['id']] = copy.deepcopy(tag)
            written[tag['id']] = copy.deepcopy(tag)
        for update in updates:
            tag = vocabulary.tags[update['id']]
            tag.update(copy.deepcopy(update['fields']))
            tag.update(version=tag['version'] + 1, updated_at=update['at'])
            written[tag['id']] = copy.deepcopy(tag)
        for link in links:
            current = vocabulary.links.get(link['id'])
            vocabulary.links[link['id']] = {**(current or {}), **link,
                                            'version': (current or {'version': 0})['version'] + 1}
        for revision in revisions:
            vocabulary.revisions.append({**revision, 'version': vocabulary.tags[revision['tag_id']]['version']})
        return written


class MemoryVocabulary:
    def __init__(self):
        self.tags, self.links, self.items, self.revisions = {}, {}, {}, []
        self.lock = asyncio.Lock()

    def in_space(self, space_id, namespace_keys, statuses=LIVE):
        return sorted((tag for tag in self.tags.values() if tag['space_id'] == space_id
                       and (namespace_keys is None or tag['namespace_key'] in namespace_keys)
                       and tag['status'] in statuses),
                      key=lambda tag: tag['name_key'])

    def reader(self, space_id):
        return MemoryTagReader(self, space_id)

    @asynccontextmanager
    async def locked(self, space_id):
        async with self.lock:
            yield MemoryLockedVocabulary(self, space_id)

    def seed(self, names, namespace_key='personal'):
        """Synthetic vocabulary written directly, for sizes no test should create one by one."""
        at = datetime.now(timezone.utc)
        for name in names:
            key = identity_key(name)
            self.tags[f'seed-{namespace_key}-{key}'] = {
                'id': f'seed-{namespace_key}-{key}', 'space_id': SPACE, 'name': name, 'name_key': key,
                'namespace_kind': namespace_key.split(':')[0], 'namespace_key': namespace_key,
                'namespace_project_id': None, 'description': None, 'language': None, 'aliases': [],
                'alias_keys': [], 'alias_statuses': [], 'proposed_aliases': [], 'proposed_alias_keys': [],
                'status': 'active', 'initial_status': 'active', 'source_kind': 'human',
                'source_application': None, 'source_reason': 'seed', 'distinct_from': [],
                'created_at': at, 'updated_at': at, 'version': 1}
        return [f'seed-{namespace_key}-{identity_key(name)}' for name in names]

    async def item_scope(self, space, item_kind, item_id):
        item = self.items.get((item_kind, item_id))
        return None if item is None else item['scope']

    async def item_titles(self, space, refs):
        return {(ref['item_kind'], ref['item_id']): self.items[(ref['item_kind'], ref['item_id'])].get('name')
                for ref in refs if (ref['item_kind'], ref['item_id']) in self.items}

    async def metrics(self, space_id, namespace_keys, since):
        tags = self.in_space(space_id, namespace_keys)
        counts, created = {}, {}
        for tag in tags:
            key = (tag['namespace_kind'], tag['status'])
            counts[key] = counts.get(key, 0) + 1
            if tag['created_at'] >= since:
                day = created.setdefault(tag['created_at'].date().isoformat(), [0, 0])
                day[0] += 1
                day[1] += tag['initial_status'] == 'provisional'
        return ([{'namespace': namespace, 'status': status, 'count': count}
                 for (namespace, status), count in sorted(counts.items())],
                [{'date': date, 'created': values[0], 'provisional': values[1]}
                 for date, values in sorted(created.items())])


class ProjectDriver:
    """Answers only the shared personal-project authorization query."""

    def __init__(self, projects):
        self.projects = projects

    async def execute_query(self, query, **parameters):
        assert 'CONTAINS_PROJECT' in query, query
        project = parameters['project_id']
        return ([{'project': {'project_id': project}}] if project in self.projects else []), None, None


class MemoryStore:
    def __init__(self):
        self.projects = set()
        self.vocabulary = MemoryVocabulary()
        self.settings = SimpleNamespace(provider_mode='personal', tag_similarity_threshold=THRESHOLD)
        self.runtime = SimpleNamespace(driver=ProjectDriver(self.projects),
                                       embedder=LocalHashEmbedder(EMBEDDING_DIM))

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        if space_id != SPACE:
            raise HTTPException(status_code=403, detail='space access denied')
        return {'id': space_id, 'kind': 'personal', 'group_id': 'synthetic-group'}

    def knowledge_tag_vocabulary(self):
        return self.vocabulary


class MemoryWorld:
    def __init__(self, client, store):
        self.client, self.store, self.space = client, store, SPACE
        self.counter = 0

    @property
    def vocabulary(self):
        return self.store.vocabulary

    async def project(self, project_id):
        self.store.projects.add(project_id)

    def _add(self, kind, scope, **state):
        self.counter += 1
        item_id = f'synthetic-item-{self.counter}'
        self.vocabulary.items[(kind, item_id)] = {'scope': scope, 'confirmation_status': 'pending',
                                                  **state}
        return {'item_kind': kind, 'item_id': item_id}

    async def item(self, project_id, name):
        # As in the Neo4j world: a global preference, or one assigned to a project.
        return self._add('entity', ('global', []) if project_id is None else ('projects', [project_id]),
                         name=name)

    async def sourced_item(self, kind, project_ids):
        return self._add(kind, ('projects', sorted(project_ids)) if project_ids else ('unknown', []))

    async def item_state(self, item):
        state = dict(self.vocabulary.items[(item['item_kind'], item['item_id'])])
        state.pop('scope')
        return state

    async def stored(self):
        """Every tag's and link's stored record, for exact before/after comparisons."""
        return copy.deepcopy(self.vocabulary.tags), copy.deepcopy(self.vocabulary.links)

    async def attached(self, item):
        """The tag IDs an item's attached links name, one entry per link."""
        return sorted(link['tag_id'] for link in self.vocabulary.links.values() if link['status'] == 'attached'
                      and (link['item_kind'], link['item_id']) == (item['item_kind'], item['item_id']))


@asynccontextmanager
async def memory_world():
    store = MemoryStore()
    application = FastAPI()

    async def actor():
        return {'id': 'synthetic-owner'}

    async def review_aware(x_fuli_human_review_token: Annotated[str | None, Header()] = None):
        if x_fuli_human_review_token is None:
            return await actor()
        return await reviewer(x_fuli_human_review_token)

    async def reviewer(x_fuli_human_review_token: Annotated[str | None, Header()] = None):
        # The app's HumanReviewer: the console's token, or 403.
        if x_fuli_human_review_token != REVIEW_TOKEN:
            raise HTTPException(status_code=403, detail='independent human review proof required')
        return {'id': 'synthetic-owner', '_human_review_verified': True}

    register_knowledge_tag_routes(application, store, Annotated[dict, Depends(actor)],
                                  Annotated[dict, Depends(review_aware)], Annotated[dict, Depends(reviewer)])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application),
                                 base_url='http://provider.test') as client:
        yield MemoryWorld(client, store)
