"""Tag vocabulary scenarios (rec#5 section 3, scene 2, G4-1..G4-4, G2-5).

Each scenario drives only the Provider HTTP routes. A world supplies the
client, one personal space, projects and knowledge items; the same scenarios
run on the in-memory port and on a disposable Neo4j. Synthetic data only.
"""
import asyncio

TAGS = '/v1/knowledge-tags'


async def post(world, operation, body, status=200):
    response = await world.client.post(f'{TAGS}/{operation}', json={
        'personal_space_id': world.space, **body})
    assert response.status_code == status, response.text
    return response.json()


async def resolve(world, query, project=None, **options):
    return (await post(world, 'resolve', {
        'personal_project_id': project, 'query': query, **options}))['candidates']


async def create(world, name, project=None, status=200, **options):
    body = {'personal_project_id': project, 'name': name,
            'reason': options.pop('reason', f'Synthetic task needs {name}'), **options}
    return await post(world, 'create', body, status)


async def alias(world, tag_id, word, project=None, **options):
    return await post(world, 'aliases', {'personal_project_id': project, 'tag_id': tag_id,
                                         'alias': word, 'reason': options.pop('reason', 'synonym'),
                                         **options})


def summary(candidates):
    return [(item['name'], item['match']) for item in candidates]


async def synonym_reuse(world):
    """G4-1: 「野外教学」 reuses 「户外学习」 through an alias a person accepts."""
    await world.project('rural-nature-class')
    await world.project('field-course')
    outdoor = await create(world, '户外学习', namespace='personal',
                           description='在户外开展的学习活动，包括野外教学与自然观察')
    assert outdoor['outcome'] == 'created'
    tag = outdoor['tag']
    assert (tag['namespace'], tag['status'], tag['version']) == ('personal', 'provisional', 1)

    # A new project asks with the synonym: the existing tag is a candidate.
    found = await resolve(world, '野外教学', 'field-course')
    assert summary(found) == [('户外学习', 'similar')]
    assert found[0]['basis'] == 'description'
    # Creating it anyway asks for a decision instead of a second identity.
    undecided = await create(world, '野外教学', 'field-course')
    assert undecided['outcome'] == 'needs_decision'
    assert undecided['tag'] is None
    assert [item['id'] for item in undecided['candidates']] == [tag['id']]

    # An Agent's alias on a personal tag is only a proposal: it changes no resolve.
    proposed = await alias(world, tag['id'], '野外教学', 'field-course', reason='同一种户外教学安排')
    assert proposed['outcome'] == 'proposed'
    assert (proposed['tag']['aliases'], proposed['tag']['proposed_aliases']) == ([], ['野外教学'])
    assert summary(await resolve(world, '野外教学', 'field-course')) == [('户外学习', 'similar')]
    # The person accepts it by adding the same alias.
    added = await alias(world, tag['id'], '野外教学', operation_actor='human', reason='是同一件事')
    assert added['outcome'] == 'added'
    assert (added['tag']['aliases'], added['tag']['proposed_aliases'],
            added['tag']['provisional_aliases'], added['tag']['version']) == (['野外教学'], [], [], 3)

    for project in ('field-course', 'rural-nature-class', None):
        found = await resolve(world, ' 野外教学\n', project)
        assert summary(found) == [('户外学习', 'alias')]
        assert found[0]['alias_status'] == 'active'
    again = await create(world, '野外教学', 'field-course')
    assert (again['outcome'], again['tag']['id']) == ('existing', tag['id'])
    repeated = await alias(world, tag['id'], '野外教学', reason='again')
    assert (repeated['outcome'], repeated['tag']['version']) == ('unchanged', 3)


async def new_domain_grows(world):
    """G4-2: a pottery task grows 「陶瓷釉色实验」 with reason, source and scope; no enum change."""
    await world.project('pottery')
    created = await create(world, '陶瓷釉色实验', 'pottery',
                           description='记录釉料配比与烧成结果的实验', language='zh-CN',
                           reason='用户开始陶艺任务，现有词表没有釉色实验', source_application='codex')
    assert created['outcome'] == 'created'
    tag = created['tag']
    assert tag['namespace'] == 'project'
    assert tag['status'] == 'provisional'
    assert tag['language'] == 'zh-CN'
    assert tag['source'] == {'kind': 'agent', 'application': 'codex',
                             'reason': '用户开始陶艺任务，现有词表没有釉色实验'}
    assert summary(await resolve(world, '陶瓷釉色实验', 'pottery')) == [('陶瓷釉色实验', 'exact')]
    # A person writing in the console adds vocabulary that is active at once.
    human = await create(world, 'Glaze chemistry', 'pottery', operation_actor='human',
                         reason='I name my own topics')
    assert (human['tag']['status'], human['tag']['source']['kind']) == ('active', 'human')
    # Shared vocabulary changes wait for governance; nothing is written.
    await create(world, 'Shared pottery', 'pottery', namespace='shared', status=403)
    assert await resolve(world, 'Shared pottery', 'pottery') == []
    # A project-scoped tag needs the project it belongs to.
    await create(world, 'No project', None, namespace='project', status=422)
    # Without a current project nothing is silently widened to personal.
    await create(world, 'Unscoped', None, status=422)
    assert await resolve(world, 'Unscoped') == []


async def near_duplicates_stay_apart(world):
    """G4-3: 「表达简洁」 and 「不提供解释」 keep separate meanings; similar is never the same."""
    concise = (await create(world, '表达简洁', namespace='personal', description='用词简洁，不啰嗦'))['tag']
    near = await create(world, '表达简洁明了', namespace='personal')
    assert near['outcome'] == 'needs_decision'
    assert [(item['name'], item['match'], item['basis']) for item in near['candidates']] == [
        ('表达简洁', 'similar', 'name')]
    kept_apart = await create(world, '表达简洁明了', namespace='personal', distinct_from=[concise['id']],
                              reason='强调层次清楚，不同于用词简洁')
    assert kept_apart['outcome'] == 'created'
    assert kept_apart['tag']['distinct_from'] == [concise['id']]
    no_explanation = await create(world, '不提供解释', namespace='personal',
                                  description='只给结论，不附带推理过程')
    assert no_explanation['outcome'] == 'created'
    ids = {concise['id'], kept_apart['tag']['id'], no_explanation['tag']['id']}
    assert len(ids) == 3
    assert summary(await resolve(world, '表达简洁')) == [('表达简洁', 'exact'), ('表达简洁明了', 'similar')]
    assert summary(await resolve(world, '不提供解释')) == [('不提供解释', 'exact')]
    assert concise['aliases'] == []


async def concurrent_create(world):
    """G4-4: two Agents create the same concept at once: one identity, both links, one creation."""
    await world.project('nature-notes')
    first, second = await world.item('nature-notes', 'Bird sketch'), await world.item(
        'nature-notes', 'Leaf rubbing')
    # The same concept arrives with different spacing, line breaks and a BOM.
    results = await asyncio.gather(*[
        create(world, name, 'nature-notes', reason=f'Agent {index} found a new concept')
        for index, name in enumerate(['自然笔记', ' 自然笔记' + chr(10), chr(0xFEFF) + '自然笔记', '自然笔记'])])
    assert len({result['tag']['id'] for result in results}) == 1, results
    assert sorted(result['outcome'] for result in results) == ['created', 'existing', 'existing', 'existing']
    tag_id = results[0]['tag']['id']
    linked = await asyncio.gather(*[
        post(world, 'attach', {'personal_project_id': 'nature-notes', 'tag_id': tag_id, **item})
        for item in (first, second, first)])
    assert sorted(result['outcome'] for result in linked).count('attached') == 2
    for item in (first, second):
        tags = (await post(world, 'attach', {'personal_project_id': 'nature-notes',
                                             'tag_id': tag_id, **item}))['tags']
        assert [tag['id'] for tag in tags] == [tag_id]
    current = [tag for tag in (await resolve(world, '自然笔记', 'nature-notes'))
               if tag['id'] == tag_id]
    assert current and current[0]['match'] == 'exact'
    metrics = await post(world, 'metrics', {'personal_project_id': 'nature-notes'})
    # Creation evidence counted once per identity, not once per Agent.
    assert sum(row['created'] for row in metrics['created_by_day']) == 1
    assert metrics['counts'] == [{'namespace': 'project', 'status': 'provisional', 'count': 1}]


async def concurrent_near_duplicates(world):
    """G4-4 for similar names: two near-duplicates created at once are judged in turn,
    so the second one needs a decision instead of slipping past distinct_from."""
    for attempt in range(4):
        project = f'outdoor-{attempt}'
        await world.project(project)
        results = await asyncio.gather(create(world, '户外学习', project),
                                       create(world, '户外学习活动', project))
        assert sorted(result['outcome'] for result in results) == ['created', 'needs_decision'], results
        created = next(result for result in results if result['outcome'] == 'created')
        undecided = next(result for result in results if result['outcome'] == 'needs_decision')
        assert [item['id'] for item in undecided['candidates']] == [created['tag']['id']]


async def alias_changes_similarity_in_turn(world):
    """An alias and a create of a word close to it race; the create sees the alias or precedes it."""
    for attempt in range(4):
        project = f'field-{attempt}'
        await world.project(project)
        outdoor = (await create(world, '户外学习', project))['tag']
        aliased, created = await asyncio.gather(
            alias(world, outdoor['id'], 'field teaching', project),
            create(world, 'field teaching notes', project, distinct_from=[]))
        assert aliased['outcome'] == 'added'
        if created['outcome'] == 'needs_decision':
            assert [item['id'] for item in created['candidates']] == [outdoor['id']]
        else:
            assert created['outcome'] == 'created'
            assert aliased['tag']['updated_at'] >= created['tag']['created_at']


async def no_cross_project_leak(world):
    """G2-5 and scene 2: same names across projects never cross; no names or counts leak."""
    await world.project('client-copy')
    await world.project('nature-class')
    private = await create(world, '夸张标题', 'client-copy', description='客户文案要求的夸张标题')
    await create(world, '客户A私密', 'client-copy')
    secret_item = await world.item('client-copy', 'Client headline rule')
    await post(world, 'attach', {'personal_project_id': 'client-copy',
                                 'tag_id': private['tag']['id'], **secret_item})
    mine = await create(world, '夸张标题', 'nature-class', description='自然课里也会讨论的标题')
    assert (mine['outcome'], mine['candidates']) == ('created', [])
    assert mine['tag']['id'] != private['tag']['id']
    # Refusals list candidates too; none from the other project.
    near = await create(world, '夸张标题党', 'nature-class')
    assert [item['id'] for item in near['candidates']] == [mine['tag']['id']]

    seen = await resolve(world, '夸张标题', 'nature-class', limit=20)
    assert [item['id'] for item in seen] == [mine['tag']['id']]
    assert await resolve(world, '客户A私密', 'nature-class') == []
    assert await resolve(world, '客户', 'nature-class') == []
    assert await resolve(world, '夸张标题') == [], 'no project means only personal vocabulary'
    # The other project's tag and item cannot be read, changed or linked from here.
    for operation, body in [
        ('aliases', {'tag_id': private['tag']['id'], 'alias': '标题党', 'reason': 'probe'}),
        ('attach', {'tag_id': private['tag']['id'], **(await world.item('nature-class', 'Bird walk'))}),
        ('attach', {'tag_id': mine['tag']['id'], **secret_item}),
        ('detach', {'tag_id': private['tag']['id'], **secret_item}),
    ]:
        refused = await world.client.post(f'{TAGS}/{operation}', json={
            'personal_space_id': world.space, 'personal_project_id': 'nature-class', **body})
        assert refused.status_code == 404, refused.text
        assert '客户' not in refused.text and 'client' not in refused.text.lower()
    visible = await post(world, 'metrics', {'personal_project_id': 'nature-class'})
    assert visible['scope'] == 'visible'
    assert visible['counts'] == [{'namespace': 'project', 'status': 'provisional', 'count': 1}]
    owner = await post(world, 'metrics', {'personal_project_id': None, 'include_all_projects': True})
    assert owner['scope'] == 'all'
    assert owner['counts'] == [{'namespace': 'project', 'status': 'provisional', 'count': 3}]
    # Unknown projects are refused instead of answering for them.
    await post(world, 'resolve', {'personal_project_id': 'missing-project', 'query': '夸张标题'}, 404)


async def item_scope_is_never_guessed(world):
    """Knowledge from several projects, or of unknown source, is not global (G2-5)."""
    for project in ('private-a', 'private-b', 'third-c'):
        await world.project(project)
    tags = {project: (await create(world, f'来源{project}', project))['tag']['id']
            for project in ('private-a', 'private-b', 'third-c')}
    personal = (await create(world, '来源个人', namespace='personal'))['tag']['id']
    shared_entity = await world.sourced_item('entity', ['private-a', 'private-b'])
    shared_edge = await world.sourced_item('relationship', ['private-a', 'private-b'])
    unknown = await world.sourced_item('entity', [])
    missing = await post(world, 'attach', {'personal_project_id': 'third-c', 'tag_id': tags['third-c'],
                                           'item_kind': 'entity', 'item_id': 'missing-item'}, 404)
    for item in (shared_entity, shared_edge, unknown):
        refused = await post(world, 'attach', {'personal_project_id': 'third-c',
                                               'tag_id': tags['third-c'], **item}, 404)
        assert refused == missing
    for item in (shared_entity, shared_edge):
        for project in ('private-a', 'private-b'):
            attached = await post(world, 'attach', {'personal_project_id': project,
                                                    'tag_id': tags[project], **item})
            assert attached['outcome'] == 'attached'
        # A personal tag from no project cannot reach project knowledge either.
        assert await post(world, 'attach', {'personal_project_id': None, 'tag_id': personal,
                                            **item}, 404) == missing
    # Knowledge of unknown source is tagged only in the personal scope.
    assert await post(world, 'attach', {'personal_project_id': 'private-a', 'tag_id': personal,
                                        **unknown}, 404) == missing
    assert (await post(world, 'attach', {'personal_project_id': None, 'tag_id': personal,
                                         **unknown}))['outcome'] == 'attached'


async def tags_never_grant_or_confirm(world):
    """Tags organize; they never change an item's content, confirmation or authority.
    A person's active tag is governance status only and confirms nothing either."""
    await world.project('teaching')
    item = await world.item('teaching', 'Use outdoor observation first')
    shared = await world.item(None, 'Prefer short sentences')
    before = await world.item_state(item)
    tag = (await create(world, '观察优先', 'teaching'))['tag']
    personal = (await create(world, '短句', namespace='personal'))['tag']
    mine = (await create(world, '我的教学', 'teaching', operation_actor='human', reason='mine'))['tag']
    assert mine['status'] == 'active'
    attached = await post(world, 'attach', {'personal_project_id': 'teaching', 'tag_id': tag['id'], **item})
    assert attached['outcome'] == 'attached'
    assert [entry['name'] for entry in attached['tags']] == ['观察优先']
    await post(world, 'attach', {'personal_project_id': 'teaching', 'tag_id': mine['id'],
                                 'operation_actor': 'human', **item})
    assert await world.item_state(item) == before
    # A global item can carry tags in any project; a project tag shows only there.
    await post(world, 'attach', {'personal_project_id': 'teaching', 'tag_id': tag['id'], **shared})
    await post(world, 'attach', {'personal_project_id': None, 'tag_id': personal['id'], **shared})
    await world.project('other-class')
    elsewhere = await post(world, 'attach', {'personal_project_id': 'other-class',
                                             'tag_id': personal['id'], **shared})
    assert (elsewhere['outcome'], [entry['name'] for entry in elsewhere['tags']]) == ('unchanged', ['短句'])
    detached = await post(world, 'detach', {'personal_project_id': 'teaching', 'tag_id': tag['id'], **item})
    assert (detached['outcome'], [entry['name'] for entry in detached['tags']]) == ('detached', ['我的教学'])
    assert (await post(world, 'detach', {'personal_project_id': 'teaching', 'tag_id': tag['id'],
                                         **item}))['outcome'] == 'unchanged'
    reattached = await post(world, 'attach', {'personal_project_id': 'teaching', 'tag_id': tag['id'], **item})
    assert reattached['outcome'] == 'attached'
    assert await world.item_state(item) == before
    await post(world, 'attach', {'personal_project_id': 'teaching', 'tag_id': tag['id'],
                                 'item_kind': 'entity', 'item_id': 'missing-item'}, 404)


SCENARIOS = [synonym_reuse, new_domain_grows, near_duplicates_stay_apart, concurrent_create,
             concurrent_near_duplicates, alias_changes_similarity_in_turn, no_cross_project_leak,
             item_scope_is_never_guessed, tags_never_grant_or_confirm]
