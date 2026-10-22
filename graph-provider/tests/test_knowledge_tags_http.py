"""Tag vocabulary scenarios through the Provider routes on an in-memory port
(knowledge_tag_memory.py). Cypher itself is covered by test_knowledge_tags_neo4j.py.
"""
import json
import random

import pytest
from pydantic import ValidationError

from fuli_graph.knowledge_tag_models import KnowledgeTagCreate

from knowledge_tag_memory import EMBEDDING_DIM, SPACE, THRESHOLD, MemoryVocabulary, memory_world
from knowledge_tag_scenarios import SCENARIOS, alias, create, post, resolve


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', SCENARIOS, ids=lambda scenario: scenario.__name__)
async def test_tag_vocabulary_scenario(scenario):
    async with memory_world() as world:
        await scenario(world)


@pytest.mark.asyncio
async def test_a_project_tag_reuses_a_personal_tag_unless_judged_different():
    async with memory_world() as world:
        await world.project('novel')
        writing = (await create(world, '写作', namespace='personal', operation_actor='human',
                                reason='mine'))['tag']
        await alias(world, writing['id'], 'Writing', operation_actor='human')
        for word in ('写作', ' writing '):
            reused = await create(world, word, 'novel')
            assert (reused['outcome'], reused['tag']['id']) == ('existing', writing['id'])
        assert len(world.vocabulary.tags) == 1
        own = await create(world, '写作', 'novel', distinct_from=[writing['id']],
                           reason='this novel means drafting chapters')
        assert own['outcome'] == 'created'
        assert (own['tag']['namespace'], own['tag']['distinct_from']) == ('project', [writing['id']])
        # The project's own same-name tag is now the one a creation there returns.
        again = await create(world, '写作', 'novel', distinct_from=[writing['id']])
        assert (again['outcome'], again['tag']['id']) == ('existing', own['tag']['id'])


@pytest.mark.asyncio
async def test_a_personal_tag_never_scans_projects_but_shows_a_same_name_project_tag():
    async with memory_world() as world:
        await world.project('nature')
        project_tag = (await create(world, '户外学习', 'nature'))['tag']
        # Similar project tags are not part of a personal decision.
        near = await create(world, '户外学习活动', 'nature', namespace='personal')
        assert (near['outcome'], near['candidates']) == ('created', [])
        # The same word in the current project is a scope difference, not a reusable tag.
        same = await create(world, '户外学习', 'nature', namespace='personal')
        assert same['outcome'] == 'needs_decision'
        assert [(item['id'], item['namespace'], item['match']) for item in same['candidates']] == [
            (project_tag['id'], 'project', 'exact'), (near['tag']['id'], 'personal', 'similar')]
        assert 'only there' in same['guidance']
        personal = await create(world, '户外学习', 'nature', namespace='personal',
                                distinct_from=[project_tag['id'], near['tag']['id']])
        assert (personal['outcome'], personal['tag']['namespace']) == ('created', 'personal')
        # Without the project the personal create sees nothing of it.
        elsewhere = await create(world, '户外学习活动计划', namespace='personal')
        assert all(item['namespace'] == 'personal' for item in elsewhere['candidates'])


@pytest.mark.asyncio
async def test_alias_that_would_make_two_tags_ambiguous_is_refused_with_every_holder():
    async with memory_world() as world:
        await world.project('stories')
        tale = (await create(world, 'tale', 'stories'))['tag']
        assert (await alias(world, tale['id'], 'Story', 'stories'))['outcome'] == 'added'
        story = (await create(world, 'story', namespace='personal'))['tag']
        narrative = (await create(world, 'narrative', 'stories'))['tag']
        refused = await alias(world, narrative['id'], ' STORY ', 'stories', reason='not a synonym')
        assert refused['outcome'] == 'conflict'
        assert refused['normalized'] == 'story'
        assert {(item['id'], item['match'], item['namespace'], item['status'])
                for item in refused['candidates']} == {
            (story['id'], 'exact', 'personal', 'provisional'), (tale['id'], 'alias', 'project', 'provisional')}
        assert set(refused['candidates'][0]) == {'id', 'name', 'namespace', 'status', 'match', 'basis'}
        assert refused['tag']['aliases'] == []
        assert [revision['action'] for revision in world.vocabulary.revisions].count('add_alias') == 1


@pytest.mark.asyncio
async def test_an_agent_alias_takes_effect_only_on_its_own_provisional_project_tag():
    async with memory_world() as world:
        await world.project('class')
        draft = (await create(world, '户外学习', 'class'))['tag']
        added = await alias(world, draft['id'], '野外课', 'class')
        assert (added['outcome'], added['tag']['provisional_aliases']) == ('added', ['野外课'])
        found = await resolve(world, '野外课', 'class')
        assert [(item['id'], item['match'], item['alias_status']) for item in found] == [
            (draft['id'], 'alias', 'provisional')]
        revision = world.vocabulary.revisions[-1]
        assert {field: revision[field] for field in ('action', 'alias', 'alias_status', 'actor_kind',
                                                     'version')} == {
            'action': 'add_alias', 'alias': '野外课', 'alias_status': 'provisional',
            'actor_kind': 'agent', 'version': 2}

        # The person's active tag and a personal tag only take proposals.
        active = (await create(world, '观察记录', 'class', operation_actor='human', reason='mine'))['tag']
        personal = (await create(world, '短句', namespace='personal'))['tag']
        for tag, word in ((active, '观察日志'), (personal, '简短句子')):
            proposed = await alias(world, tag['id'], word, 'class')
            assert proposed['outcome'] == 'proposed', proposed
            assert (proposed['tag']['aliases'], proposed['tag']['proposed_aliases']) == ([], [word])
            assert 'proposal' in proposed['guidance']
            assert all(item['match'] != 'alias' for item in await resolve(world, word, 'class'))
            assert (await alias(world, tag['id'], word, 'class'))['outcome'] == 'unchanged'
        assert world.vocabulary.revisions[-1]['alias_status'] == 'proposed'
        # A proposal holds no word: another tag may still take it.
        assert (await alias(world, draft['id'], '观察日志', 'class'))['outcome'] == 'added'


@pytest.mark.asyncio
async def test_a_person_confirming_a_provisional_alias_records_one_revision():
    async with memory_world() as world:
        await world.project('class')
        draft = (await create(world, '户外学习', 'class'))['tag']
        await alias(world, draft['id'], '野外课', 'class')
        for _ in range(2):
            await alias(world, draft['id'], '野外课', 'class', operation_actor='human', reason='accept')
        assert [(revision['action'], revision['alias_status'], revision['actor_kind'],
                 revision['version']) for revision in world.vocabulary.revisions] == [
            ('create', None, 'agent', 1), ('add_alias', 'provisional', 'agent', 2),
            ('confirm_alias', 'active', 'human', 3)]
        stored = world.vocabulary.tags[draft['id']]
        assert (stored['aliases'], stored['alias_keys'], stored['alias_statuses']) == (
            ['野外课'], ['野外课'], ['active'])


@pytest.mark.asyncio
async def test_distinct_from_must_name_every_candidate():
    async with memory_world() as world:
        world.vocabulary.seed(['garden', 'garden plan', 'garden plans for spring'])
        first = await create(world, 'garden plans', namespace='personal')
        assert first['outcome'] == 'needs_decision'
        ids = [item['id'] for item in first['candidates']]
        assert len(ids) == first['undecided'] == 3
        partly = await create(world, 'garden plans', namespace='personal', distinct_from=ids[:1])
        assert partly['outcome'] == 'needs_decision'
        assert ([item['id'] for item in partly['candidates']], partly['undecided']) == (ids[1:], 2)
        done = await create(world, 'garden plans', namespace='personal', distinct_from=ids)
        assert done['outcome'] == 'created'
        assert done['tag']['distinct_from'] == sorted(ids)


@pytest.mark.asyncio
async def test_more_candidates_than_distinct_from_can_hold_is_refused_with_a_next_step():
    async with memory_world() as world:
        ids = world.vocabulary.seed([f'observation note {index}' for index in range(51)])
        for acknowledged in ([], ids[:50]):
            refused = await create(world, 'observation note', namespace='personal',
                                   distinct_from=acknowledged)
            assert refused['outcome'] == 'needs_decision'
            assert refused['undecided'] == 51 - len(acknowledged)
            assert len(refused['candidates']) <= 5
            assert 'more specific name' in refused['guidance']


@pytest.mark.asyncio
async def test_a_truncated_similarity_scan_says_so():
    async with memory_world() as world:
        world.vocabulary.seed([f'z{index:05d}' for index in range(2001)])
        found = await post(world, 'resolve', {'query': '野花'})
        assert (found['candidates'], found['truncated']) == ([], True)
        created = await create(world, '野花', namespace='personal')
        assert (created['outcome'], created['truncated']) == ('created', True)
    async with memory_world() as world:
        assert (await post(world, 'resolve', {'query': '野花'}))['truncated'] is False


@pytest.mark.asyncio
async def test_refusals_are_compact_and_name_the_normalized_word():
    async with memory_world() as world:
        await create(world, '表达简洁', namespace='personal', description='用词简洁' * 40)
        refused = await create(world, ' 表达简洁明了\n', namespace='personal')
        assert refused['outcome'] == 'needs_decision'
        assert refused['normalized'] == '表达简洁明了'
        assert set(refused['candidates'][0]) == {'id', 'name', 'namespace', 'status', 'match', 'basis'}
        assert refused['similarity_version'] == f'lexical-hash/fuli-embed-v1/{EMBEDDING_DIM}@{THRESHOLD:g}'
        assert len(json.dumps(refused, ensure_ascii=False).encode()) < 700


# Frozen near-miss pairs at the default threshold. Similarity is lexical: a
# respelling or a reordering is found; a different topic that shares a
# character, or a synonym that shares none, is not (that needs an alias).
SIMILAR_PAIRS = [('户外学习', '户外 学习'), ('code review', 'code-review'), ('color theory', 'colour theory'),
                 ('frontend', 'front end'), ('lesson plan', 'plan lesson'), ('测试用例', '测试用列'),
                 ('writing', 'writer'), ('design system', 'design systems')]
DIFFERENT_PAIRS = [('户外学习', '户外教学'), ('日本料理', '日本旅行'), ('frontend', 'backend'),
                   ('cat', 'car'), ('数学', '数字'), ('教学', '教室'), ('写作', '小说')]


async def _proposed_for(world, existing, query):
    world.store.vocabulary = MemoryVocabulary()
    await create(world, existing, namespace='personal', operation_actor='human', reason='fixture')
    return await resolve(world, query)


@pytest.mark.asyncio
@pytest.mark.parametrize(('existing', 'query', 'similar'),
                         [(*pair, True) for pair in SIMILAR_PAIRS]
                         + [(*pair, False) for pair in DIFFERENT_PAIRS])
async def test_frozen_near_misses(existing, query, similar):
    async with memory_world() as world:
        found = await _proposed_for(world, existing, query)
        assert [item['match'] for item in found] == (['similar'] if similar else [])


def _random_name(rng):
    script = rng.choice(['cjk', 'latin', 'mixed'])
    characters = []
    for _ in range(rng.randint(2, 16)):
        kind = script if script != 'mixed' else rng.choice(['cjk', 'latin'])
        characters.append(chr(rng.randint(0x4E00, 0x9FA5)) if kind == 'cjk'
                          else rng.choice('abcdefghijklmnopqrstuvwxyz'))
    return ''.join(characters)


@pytest.mark.asyncio
async def test_unrelated_random_names_are_rarely_proposed_as_similar():
    # Measured at the defaults (dim 384, threshold 0.35) over 20,000 pairs and
    # three seeds: 0.02-0.05% of unrelated pairs reach the bar, 99th percentile
    # cosine about 0.15. This seeded sample keeps the rate under 1%.
    rng = random.Random(239)
    pairs = [(_random_name(rng), _random_name(rng)) for _ in range(400)]
    async with memory_world() as world:
        proposed = [pair for pair in pairs if pair[0] != pair[1]
                    and await _proposed_for(world, *pair)]
    assert len(proposed) / len(pairs) < 0.01, proposed


@pytest.mark.asyncio
async def test_the_similarity_threshold_is_a_provider_setting():
    async with memory_world() as world:
        assert [item['basis'] for item in await _proposed_for(world, 'writing', 'writer')] == [
            'lexical-hash']
        world.store.settings.tag_similarity_threshold = 0.9
        assert await _proposed_for(world, 'writing', 'writer') == []
        version = (await post(world, 'resolve', {'query': 'writer'}))['similarity_version']
        assert version.endswith('@0.9')
        recorded = await create(world, 'writer', namespace='personal')
        assert world.vocabulary.revisions[-1]['similarity_version'] == version
        assert recorded['similarity_version'] == version


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [
    {'name': '\u0000bad', 'reason': 'control character'},
    {'name': '   ', 'reason': 'blank'},
    {'name': 'x' * 81, 'reason': 'too long'},
    {'name': 'token', 'reason': 'sk-' + 'a' * 40},
    {'name': 'valid', 'reason': 'ok', 'language': 'not a language'},
    {'name': 'valid', 'reason': 'ok', 'distinct_from': [f'id-{index}' for index in range(51)]},
])
async def test_invalid_tag_input_is_rejected_before_any_write(body):
    async with memory_world() as world:
        response = await world.client.post('/v1/knowledge-tags/create', content=json.dumps({
            'personal_space_id': SPACE, 'namespace': 'personal', **body}),
            headers={'content-type': 'application/json'})
        assert response.status_code == 422, response.text
        assert world.vocabulary.tags == {}


def test_a_lone_surrogate_never_reaches_the_vocabulary():
    # The request model refuses it before any route code runs.
    for name in ['\ud800', '\udc00\ud800', '笔记\udfff']:
        with pytest.raises(ValidationError):
            KnowledgeTagCreate(personal_space_id=SPACE, name=name, reason='broken client')


@pytest.mark.asyncio
async def test_an_item_carries_a_limited_number_of_tags():
    async with memory_world() as world:
        item = await world.item(None, 'Synthetic preference')
        tag_ids = world.vocabulary.seed([chr(0x4E00 + index * 101) for index in range(33)])
        for tag_id in tag_ids[:32]:
            response = await world.client.post('/v1/knowledge-tags/attach', json={
                'personal_space_id': SPACE, 'tag_id': tag_id, **item})
            assert response.json()['outcome'] == 'attached'
        refused = await world.client.post('/v1/knowledge-tags/attach', json={
            'personal_space_id': SPACE, 'tag_id': tag_ids[32], **item})
        assert refused.status_code == 409, refused.text
