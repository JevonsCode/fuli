"""Tag vocabulary scenarios through the Provider routes on an in-memory port.

The port keeps the same atomic contract as the Neo4j one (create-unless-a-
visible-key-exists and alias checks under one per-space lock), yielding between
reads and writes so concurrent requests really interleave. Cypher itself is
covered by test_knowledge_tags_neo4j.py.
"""
import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException
from pydantic import ValidationError

from fuli_graph.knowledge_tag_models import KnowledgeTagCreate
from fuli_graph.knowledge_tag_routes import register_knowledge_tag_routes
from fuli_graph.runtime import LocalHashEmbedder

from knowledge_tag_scenarios import SCENARIOS

SPACE = 'synthetic-tag-space'


class MemoryVocabulary:
    def __init__(self):
        self.tags, self.links, self.items, self.revisions = {}, {}, {}, []
        self.lock = asyncio.Lock()

    def _visible(self, space_id, namespace_keys):
        return [tag for tag in self.tags.values() if tag['space_id'] == space_id
                and (namespace_keys is None or tag['namespace_key'] in namespace_keys)
                and tag['status'] in ('provisional', 'active')]

    async def find_by_key(self, space_id, namespace_keys, key):
        return [dict(tag) for tag in self._visible(space_id, namespace_keys)
                if tag['name_key'] == key or key in tag['alias_keys']]

    async def list_visible(self, space_id, namespace_keys, limit):
        return [dict(tag) for tag in self._visible(space_id, namespace_keys)][:limit]

    async def get(self, space_id, tag_id):
        tag = self.tags.get(tag_id)
        return dict(tag) if tag and tag['space_id'] == space_id else None

    async def create(self, space_id, tag, namespace_keys, revision):
        async with self.lock:
            existing = await self.find_by_key(space_id, namespace_keys, tag['name_key'])
            await asyncio.sleep(0)
            if existing:
                return existing[0], False
            if tag['id'] in self.tags:
                return dict(self.tags[tag['id']]), False
            self.tags[tag['id']] = dict(tag)
            self.revisions.append({**revision, 'version': 1})
            return dict(tag), True

    async def add_alias(self, space_id, tag_id, alias, alias_key, namespace_keys, revision):
        async with self.lock:
            tag = self.tags[tag_id]
            if alias_key == tag['name_key'] or alias_key in tag['alias_keys']:
                return 'unchanged', dict(tag)
            others = [other for other in await self.find_by_key(space_id, namespace_keys, alias_key)
                      if other['id'] != tag_id]
            await asyncio.sleep(0)
            if others:
                return 'conflict', others[0]
            tag.update(aliases=[*tag['aliases'], alias], alias_keys=[*tag['alias_keys'], alias_key],
                       version=tag['version'] + 1, updated_at=revision['created_at'])
            self.revisions.append({**revision, 'version': tag['version']})
            return 'added', dict(tag)

    async def item_project(self, space, item_kind, item_id):
        item = self.items.get((item_kind, item_id))
        return (False, None) if item is None else (True, item['project_id'])

    async def attach(self, space_id, link, limit):
        async with self.lock:
            current = self.links.get(link['id'])
            await asyncio.sleep(0)
            if current and current['status'] == 'attached':
                return 'unchanged'
            attached = [value for value in self.links.values() if value['status'] == 'attached'
                        and (value['item_kind'], value['item_id']) == (link['item_kind'], link['item_id'])]
            if len(attached) >= limit:
                return 'limit'
            self.links[link['id']] = {**link, 'version': (current or {'version': 0})['version'] + 1}
            return 'attached'

    async def detach(self, space_id, link_id, detached_at, actor_kind):
        async with self.lock:
            current = self.links.get(link_id)
            if not current or current['status'] != 'attached':
                return 'unchanged'
            current.update(status='detached', detached_at=detached_at, detached_by_kind=actor_kind,
                           version=current['version'] + 1)
            return 'detached'

    async def item_tags(self, space_id, item_kind, item_id, namespace_keys):
        visible = {tag['id']: tag for tag in self._visible(space_id, namespace_keys)}
        return sorted((dict(visible[link['tag_id']]) for link in self.links.values()
                       if link['status'] == 'attached' and link['tag_id'] in visible
                       and (link['item_kind'], link['item_id']) == (item_kind, item_id)),
                      key=lambda tag: tag['name_key'])

    async def metrics(self, space_id, namespace_keys, since):
        tags = self._visible(space_id, namespace_keys)
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
        self.settings = SimpleNamespace(provider_mode='personal')
        self.runtime = SimpleNamespace(driver=ProjectDriver(self.projects),
                                       embedder=LocalHashEmbedder(384))

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

    async def project(self, project_id):
        self.store.projects.add(project_id)

    async def item(self, project_id, name):
        self.counter += 1
        item_id = f'synthetic-item-{self.counter}'
        self.store.vocabulary.items[('entity', item_id)] = {
            'project_id': project_id, 'name': name, 'confirmation_status': 'pending'}
        return {'item_kind': 'entity', 'item_id': item_id}

    async def item_state(self, item):
        return dict(self.store.vocabulary.items[(item['item_kind'], item['item_id'])])


@asynccontextmanager
async def memory_world():
    store = MemoryStore()
    application = FastAPI()

    async def actor():
        return {'id': 'synthetic-owner'}

    register_knowledge_tag_routes(application, store, Annotated[dict, Depends(actor)])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application),
                                 base_url='http://provider.test') as client:
        yield MemoryWorld(client, store)


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', SCENARIOS, ids=lambda scenario: scenario.__name__)
async def test_tag_vocabulary_scenario(scenario):
    async with memory_world() as world:
        await scenario(world)


@pytest.mark.asyncio
async def test_alias_that_would_make_two_tags_ambiguous_is_refused():
    async with memory_world() as world:
        create = lambda name: world.client.post('/v1/knowledge-tags/create', json={
            'personal_space_id': SPACE, 'name': name, 'namespace': 'personal', 'reason': 'synthetic'})
        writing = (await create('写作')).json()['tag']
        novel = (await create('小说')).json()['tag']
        response = await world.client.post('/v1/knowledge-tags/aliases', json={
            'personal_space_id': SPACE, 'tag_id': novel['id'], 'alias': ' 写作 ', 'reason': 'not a synonym'})
        assert response.status_code == 200, response.text
        refused = response.json()
        assert refused['outcome'] == 'conflict'
        assert refused['conflict']['id'] == writing['id']
        assert refused['tag']['aliases'] == []
        assert len(world.store.vocabulary.revisions) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [
    {'name': '\u0000bad', 'reason': 'control character'},
    {'name': '   ', 'reason': 'blank'},
    {'name': 'x' * 81, 'reason': 'too long'},
    {'name': 'token', 'reason': 'sk-' + 'a' * 40},
    {'name': 'valid', 'reason': 'ok', 'language': 'not a language'},
])
async def test_invalid_tag_input_is_rejected_before_any_write(body):
    async with memory_world() as world:
        response = await world.client.post('/v1/knowledge-tags/create', content=json.dumps({
            'personal_space_id': SPACE, 'namespace': 'personal', **body}),
            headers={'content-type': 'application/json'})
        assert response.status_code == 422, response.text
        assert world.store.vocabulary.tags == {}


def test_a_lone_surrogate_never_reaches_the_vocabulary():
    # The request model refuses it before any route code runs.
    for name in ['\ud800', '\udc00\ud800', '笔记\udfff']:
        with pytest.raises(ValidationError):
            KnowledgeTagCreate(personal_space_id=SPACE, name=name, reason='broken client')


@pytest.mark.asyncio
async def test_an_item_carries_a_limited_number_of_tags():
    async with memory_world() as world:
        item = await world.item(None, 'Synthetic preference')
        tag_ids = []
        for index in range(33):
            body = {'personal_space_id': SPACE, 'name': chr(0x4E00 + index * 101), 'reason': 'limit',
                    'namespace': 'personal'}
            result = (await world.client.post('/v1/knowledge-tags/create', json=body)).json()
            if result['outcome'] == 'needs_decision':
                # The caller judged every similar candidate a different topic.
                body['distinct_from'] = [candidate['id'] for candidate in result['candidates']]
                result = (await world.client.post('/v1/knowledge-tags/create', json=body)).json()
            tag_ids.append(result['tag']['id'])
        assert len(set(tag_ids)) == 33
        for tag_id in tag_ids[:32]:
            response = await world.client.post('/v1/knowledge-tags/attach', json={
                'personal_space_id': SPACE, 'tag_id': tag_id, **item})
            assert response.json()['outcome'] == 'attached'
        refused = await world.client.post('/v1/knowledge-tags/attach', json={
            'personal_space_id': SPACE, 'tag_id': tag_ids[32], **item})
        assert refused.status_code == 409, refused.text
