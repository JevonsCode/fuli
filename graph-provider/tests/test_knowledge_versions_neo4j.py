"""rec#5 C7 (an edit is a new version) and C8 (marking outdated keeps history)
against an explicitly disposable Neo4j. Synthetic people, preferences and
projects only; public HTTP routes drive every write, except where a test seeds
a stored shape that only a multi-step review flow writes."""

import json
from uuid import uuid4

import pytest

from test_negative_feedback_block_neo4j import query, use
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import applied, commit, confirm, move, ok, preference, reviewed_settings, space_with_projects, view


async def edit(client, space_id, item_id, text, *, version, actor='human', kind='entity', reason='Synthetic edit.'):
    fields = {'name': text[:120], 'summary': text} if kind == 'entity' else {'fact': text}
    return await client.patch(f'/v1/knowledge/items/{item_id}', json={
        'personal_space_id': space_id, 'item_kind': kind, 'action': 'update', 'reason': reason,
        'operation_actor': actor, 'expected_version': version, **fields})


async def mark_outdated(client, space_id, item_id, *, version, actor='human', kind='entity'):
    return await client.patch(f'/v1/knowledge/items/{item_id}', json={
        'personal_space_id': space_id, 'item_kind': kind, 'action': 'mark_outdated',
        'reason': 'Synthetic: this is no longer how I work.', 'operation_actor': actor,
        'expected_version': version})


async def entry_instructions(client, space_id, project):
    response = ok(await client.get('/v1/collaboration-preferences', params={
        'personal_space_id': space_id, 'personal_project_id': project}))
    return {item['id']: item['instruction'] for item in response['effective_preferences']}


async def graph_node(client, space_id, item_id):
    graph = ok(await client.get(f'/v1/spaces/{space_id}/graph', params={'limit': 500}))
    [node] = [node for node in graph['nodes'] if node['id'] == item_id]
    return node


async def promote_by_usage(client, space_id, item_id):
    """Five material uses in three tasks: the Agent usage policy confirms it."""
    for index in range(5):
        await use(client, space_id, f'synthetic-task-{index % 3}', item_id, 'applied' if index < 3 else 'cited')


@pytest.mark.asyncio
async def test_c7_1_an_edit_takes_effect_at_once_and_the_old_version_is_marked_replaced():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        saved = await commit(client, space_id, [preference('reply-language', '回复用英文')])
        old_id = saved['entity_ids'][0]
        await confirm(client, space_id, old_id)
        assert (await entry_instructions(client, space_id, 'alpha')) == {old_id: '回复用英文'}
        tag = ok(await client.post('/v1/knowledge-tags/create', json={
            'personal_space_id': space_id, 'name': 'language', 'namespace': 'personal',
            'reason': 'Synthetic tag.'}))['tag']
        ok(await client.post('/v1/knowledge-tags/attach', json={
            'personal_space_id': space_id, 'tag_id': tag['id'], 'item_kind': 'entity', 'item_id': old_id}))
        before = await view(client, space_id, old_id)
        edited = await edit(client, space_id, old_id, '技术术语保留英文，其余用中文', version=before['version'],
                            reason='我改主意了')
        assert edited.status_code == 200, edited.text
        new_id = edited.json()['version_item_id']
        assert new_id and new_id != old_id
        # The next task entry delivers only the new version.
        assert (await entry_instructions(client, space_id, 'alpha')) == {new_id: '技术术语保留英文，其余用中文'}
        old = await view(client, space_id, old_id)
        assert (old['status'], old['current_item_id'], old['content']) == ('superseded', new_id, '回复用英文')
        assert old['invalid_at'] is not None
        current = await view(client, space_id, new_id)
        assert current['status'] == 'current' and current['invalid_at'] is None
        # History shows what changed, who changed it and when, on either version.
        assert current['versions'] == old['versions']
        newest, oldest = current['versions']
        assert (newest['item_id'], newest['content'], newest['status'], newest['changed_by'], newest['reason']) == (
            new_id, '技术术语保留英文，其余用中文', 'current', 'user', '我改主意了')
        assert (oldest['item_id'], oldest['content'], oldest['status']) == (old_id, '回复用英文', 'superseded')
        assert newest['created_at'] >= oldest['created_at']
        [supersede] = [revision for revision in old['revisions'] if revision['action'] == 'supersede']
        assert supersede['changed_by'] == 'user' and supersede['current']['replacedByItemId'] == new_id
        assert supersede['previous']['summary'] == '回复用英文'
        # The knowledge page reads the same states.
        assert (await graph_node(client, space_id, old_id))['version_status'] == 'superseded'
        assert (await graph_node(client, space_id, new_id))['version_status'] == 'current'
        # The new version is found where the old one was, from its own edit evidence.
        assert current['scope']['kind'] == old['scope']['kind']
        assert current['evidence'] and current['evidence'][0]['source_kind'] == 'human_knowledge_edit'
        assert current['evidence'][0]['session_id'] is None
        assert [item['id'] for item in current['tags']] == [item['id'] for item in old['tags']] == [tag['id']]
        node = await graph_node(client, space_id, new_id)
        assert node['human_change_status'] == 'unseen', 'Agents are told a person changed it'


@pytest.mark.asyncio
async def test_c7_2_cached_readers_get_the_new_version_and_old_links_cannot_write_it_back():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        saved = await commit(client, space_id, [preference('status-line', 'Prefer long status updates')])
        old_id = saved['entity_ids'][0]
        await confirm(client, space_id, old_id)
        # Two clients read and keep the old version (ID, words and edit version).
        first = await entry_instructions(client, space_id, 'alpha')
        second = await entry_instructions(client, space_id, 'alpha')
        cached = await view(client, space_id, old_id)
        assert first == second == {old_id: 'Prefer long status updates'}
        new_id = ok(await edit(client, space_id, old_id, 'Prefer short status lines',
                               version=cached['version']))['version_item_id']
        # Both clients' next read gets the new version.
        assert await entry_instructions(client, space_id, 'alpha') == {new_id: 'Prefer short status lines'}
        assert await entry_instructions(client, space_id, 'alpha') == {new_id: 'Prefer short status lines'}
        # Neither can write the old version back through its old link.
        stale = await edit(client, space_id, old_id, 'Prefer long status updates', version=cached['version'])
        assert stale.status_code == 409 and stale.json()['detail']['code'] == 'stale_version'
        fresh = await view(client, space_id, old_id)
        again = await edit(client, space_id, old_id, 'Prefer long status updates', version=fresh['version'])
        assert again.status_code == 409 and again.json()['detail']['code'] == 'superseded'
        assert again.json()['detail']['current_item_id'] == new_id
        moved = await move(client, space_id, old_id, 'projects', version=fresh['version'], projects=['alpha'])
        assert moved.status_code == 409
        late_use = await client.post('/v1/knowledge/usage', json={
            'personal_space_id': space_id, 'task_id': 'synthetic-cached-task',
            'items': [{'item_id': old_id, 'item_kind': 'entity', 'use_kind': 'applied'}]})
        assert late_use.status_code == 409
        assert late_use.json()['detail'] == {'code': 'historical', 'current_item_id': new_id,
                                             'message': 'historical knowledge cannot receive usage evidence'}
        current = await view(client, space_id, new_id)
        assert (current['content'], current['status'], current['weight']['basis']['qualified_use_count']) == (
            'Prefer short status lines', 'current', 0)
        assert await entry_instructions(client, space_id, 'alpha') == {new_id: 'Prefer short status lines'}


@pytest.mark.asyncio
async def test_c7_2_usage_while_a_page_is_open_is_not_an_edit_conflict():
    """rec#20 part 2: usage moves the write lock, not the edit version a page holds."""
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        item_id = (await commit(client, space_id, [preference('tone', 'Keep a calm tone')]))['entity_ids'][0]
        await confirm(client, space_id, item_id)
        page = await view(client, space_id, item_id)
        await use(client, space_id, 'synthetic-task-a', item_id)
        await use(client, space_id, 'synthetic-task-b', item_id, 'cited')
        assert (await view(client, space_id, item_id))['version'] == page['version']
        narrowed = await move(client, space_id, item_id, 'projects', version=page['version'], projects=['alpha'])
        assert narrowed.status_code == 200, narrowed.text
        page = await view(client, space_id, item_id)
        await use(client, space_id, 'synthetic-task-c', item_id)
        edited = await edit(client, space_id, item_id, 'Keep a calm, direct tone', version=page['version'])
        assert edited.status_code == 200, edited.text


@pytest.mark.asyncio
async def test_c7_3_a_persons_edit_of_an_agent_inferred_preference_is_theirs_and_the_old_stays_inferred():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        inferred = preference('headings', 'Use many headings', content_source='agent_inferred')
        old_id = (await commit(client, space_id, [inferred]))['entity_ids'][0]
        await promote_by_usage(client, space_id, old_id)
        before = await view(client, space_id, old_id)
        assert (before['content_source'], before['confirmation_status']) == ('agent_inferred', 'agent_confirmed')
        new_id = ok(await edit(client, space_id, old_id, 'Use headings only for long answers',
                               version=before['version']))['version_item_id']
        current = await view(client, space_id, new_id)
        assert (current['content_source'], current['confirmation_status']) == ('user_explicit', 'confirmed')
        assert current['weight']['basis']['confirmed_by_person'] is True
        assert current['weight']['basis']['qualified_use_count'] == 0, 'usage of the old words does not carry over'
        old = await view(client, space_id, old_id)
        assert (old['content_source'], old['confirmation_status']) == ('agent_inferred', 'agent_confirmed')
        assert old['weight']['basis']['qualified_use_count'] == 5
        by_id = {version['item_id']: version for version in current['versions']}
        assert (by_id[new_id]['changed_by'], by_id[new_id]['content_source']) == ('user', 'user_explicit')
        assert (by_id[old_id]['changed_by'], by_id[old_id]['content_source']) == ('agent', 'agent_inferred')
        assert by_id[old_id]['confirmation_status'] == 'agent_confirmed'
        # An Agent's rewrite is a new version too, but it waits for a person.
        agent_id = ok(await edit(client, space_id, new_id, 'Use headings for long answers and lists',
                                 version=current['version'], actor='agent'))['version_item_id']
        rewritten = await view(client, space_id, agent_id)
        assert (rewritten['content_source'], rewritten['confirmation_status']) == ('agent_inferred', 'pending')
        assert {version['item_id']: version['changed_by'] for version in rewritten['versions']}[agent_id] == 'agent'
        assert agent_id not in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_c8_1_a_preference_marked_outdated_leaves_task_entry_and_moves_to_history():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = (await commit(client, space_id, [preference('weekly-report', '周报用 Word 写')]))['entity_ids'][0]
        await confirm(client, space_id, item_id)
        assert item_id in await applied(client, space_id, 'alpha')
        before = await view(client, space_id, item_id)
        marked = await mark_outdated(client, space_id, item_id, version=before['version'])
        assert marked.status_code == 200, marked.text
        assert marked.json()['action'] == 'mark_outdated' and marked.json()['changed_by'] == 'user'
        assert item_id not in await applied(client, space_id, 'alpha')
        outdated = await view(client, space_id, item_id)
        assert (outdated['status'], outdated['content']) == ('outdated', '周报用 Word 写')
        assert outdated['invalid_at'] is not None and outdated['current_item_id'] is None
        assert outdated['weight']['basis']['negative_evidence_count'] == 1
        node = await graph_node(client, space_id, item_id)
        assert (node['version_status'], node['last_feedback_kind']) == ('outdated', 'outdated')
        [audit] = await query(settings, '''
            MATCH (:FuliSpace {id: $space})-[:HAS_KNOWLEDGE_AUDIT]->(audit:FuliKnowledgeAudit)
            WHERE audit.item_id = $item AND audit.action = 'knowledge_feedback'
            RETURN audit.feedback_kind AS kind, audit.reported_by_kind AS reporter
            ''', space=space_id, item=item_id)
        assert audit == {'kind': 'outdated', 'reporter': 'user'}
        again = await mark_outdated(client, space_id, item_id, version=outdated['version'])
        assert again.status_code == 409


@pytest.mark.asyncio
async def test_c8_2_old_and_new_usage_never_revive_an_outdated_preference():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = (await commit(client, space_id, [
            preference('weekly-report', 'Weekly reports in Word', content_source='agent_inferred')]))['entity_ids'][0]
        await promote_by_usage(client, space_id, item_id)
        assert item_id in await applied(client, space_id, 'alpha')
        before = await view(client, space_id, item_id)
        ok(await mark_outdated(client, space_id, item_id, version=before['version']))
        for task_id in ['synthetic-task-0', 'synthetic-task-new']:  # a replayed event ID, then a new use
            response = await client.post('/v1/knowledge/usage', json={
                'personal_space_id': space_id, 'task_id': task_id,
                'items': [{'item_id': item_id, 'item_kind': 'entity', 'use_kind': 'applied'}]})
            assert response.status_code == 409
        [state] = await query(settings, '''
            MATCH (item:Entity {uuid: $item})
            RETURN item.fuli_confirmation_status AS status, item.fuli_qualified_use_count AS uses,
                   item.fuli_invalid_at IS NOT NULL AS historical,
                   item.fuli_negative_feedback_block_json AS block
            ''', item=item_id)
        assert (state['status'], state['uses'], state['historical']) == ('pending', 5, True)
        assert json.loads(state['block'])['feedback_kind'] == 'outdated'
        assert item_id not in await applied(client, space_id, 'alpha')
        outdated = await view(client, space_id, item_id)
        assert outdated['status'] == 'outdated'
        # A restore would erase the time it was out of date; it is refused.
        restore = await client.patch(f'/v1/knowledge/items/{item_id}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'restore',
            'reason': 'Bring it back.', 'operation_actor': 'human', 'expected_version': outdated['version']})
        assert restore.status_code == 409 and restore.json()['detail']['code'] == 'reassert_as_new_version'
        assert (await view(client, space_id, item_id))['status'] == 'outdated'


@pytest.mark.asyncio
async def test_c8_3_saying_it_again_writes_new_evidence_and_a_new_version_and_keeps_the_gap():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        words = preference('weekly-report', '周报用 Word 写', content_source='user_explicit')
        item_id = (await commit(client, space_id, [words], key=f'first-{uuid4()}'))['entity_ids'][0]
        await confirm(client, space_id, item_id)
        ok(await mark_outdated(client, space_id, item_id, version=(await view(client, space_id, item_id))['version']))
        outdated = await view(client, space_id, item_id)
        # The person says it again; the capture names the same item key.
        again = await commit(client, space_id, [words], key=f'again-{uuid4()}')
        version_id = again['entity_ids'][0]
        assert version_id != item_id
        later = await commit(client, space_id, [words], key=f'again-{uuid4()}')
        assert later['entity_ids'][0] == version_id, 'a later mention lands on the new version, not on history'
        history = await view(client, space_id, item_id)
        assert (history['status'], history['invalid_at']) == ('outdated', outdated['invalid_at'])
        assert history['current_item_id'] == version_id
        assert 'reassert' in {revision['action'] for revision in history['revisions']}
        current = await view(client, space_id, version_id)
        assert (current['status'], current['confirmation_status'], current['content_source']) == (
            'current', 'pending', 'user_explicit')
        assert current['created_at'] > history['invalid_at'], 'the time it was not valid stays visible'
        assert {source['episode_id'] for source in current['evidence']} >= {again['episode_id']}
        assert again['episode_id'] not in {source['episode_id'] for source in history['evidence']}
        # Pending until confirmed: the new evidence does not apply by itself.
        assert version_id not in await applied(client, space_id, 'alpha')

        # In the console, re-asserting an outdated item is the same: a new version.
        other = (await commit(client, space_id, [preference('slides', 'Slides in Keynote')]))['entity_ids'][0]
        await confirm(client, space_id, other)
        ok(await mark_outdated(client, space_id, other, version=(await view(client, space_id, other))['version']))
        gap = await view(client, space_id, other)
        reasserted = ok(await edit(client, space_id, other, 'Slides in Keynote', version=gap['version'],
                                   reason='其实还是用 Keynote'))
        assert reasserted['version_item_id'] != other
        assert (await view(client, space_id, other))['invalid_at'] == gap['invalid_at']
        assert reasserted['version_item_id'] in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_c8_4_a_conclusion_drawn_from_an_outdated_preference_is_no_longer_a_current_fact():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis_id = (await commit(client, space_id, [preference('weekly-report', 'Weekly reports in Word')]))[
            'entity_ids'][0]
        await confirm(client, space_id, basis_id)
        fact = {'key': 'report-template', 'name': 'The report template is a .docx file', 'type': 'ProjectFact',
                'summary': 'The report template is a .docx file', 'derived_from': [basis_id]}
        fact_id = (await commit(client, space_id, [fact], project='alpha'))['entity_ids'][0]
        await confirm(client, space_id, fact_id)
        follow = {'key': 'report-macro', 'name': 'Report macros target Word', 'type': 'ProjectFact',
                  'summary': 'Report macros target Word', 'derived_from': [fact_id]}
        follow_id = (await commit(client, space_id, [follow], project='alpha'))['entity_ids'][0]
        assert (await view(client, space_id, fact_id))['bases'] == [
            {'item_kind': 'entity', 'item_id': basis_id, 'content': 'Weekly reports in Word', 'status': 'current'}]
        found = ok(await client.post('/v1/search', json={
            'space_ids': [space_id], 'query': 'The report template is a .docx file', 'limit': 20,
            'personal_project_ids': ['alpha'], 'active_personal_project_id': 'alpha', 'include_pending': True}))
        assert fact_id in json.dumps(found)
        marked = ok(await mark_outdated(client, space_id, basis_id,
                                        version=(await view(client, space_id, basis_id))['version']))
        assert marked['dependents_outdated'] == 2
        derived = await view(client, space_id, fact_id)
        assert derived['status'] == 'basis_outdated' and derived['invalid_at'] is not None
        assert derived['bases'][0]['status'] == 'outdated'
        [revision] = [item for item in derived['revisions'] if item['action'] == 'basis_outdated']
        assert revision['current']['basis'] == {'itemKind': 'entity', 'itemId': basis_id}
        assert (await view(client, space_id, follow_id))['status'] == 'basis_outdated'
        assert (await graph_node(client, space_id, fact_id))['version_status'] == 'basis_outdated'
        found = ok(await client.post('/v1/search', json={
            'space_ids': [space_id], 'query': 'The report template is a .docx file', 'limit': 20,
            'personal_project_ids': ['alpha'], 'active_personal_project_id': 'alpha', 'include_pending': True}))
        assert fact_id not in json.dumps(found) and follow_id not in json.dumps(found)
        # A conclusion cannot name knowledge that is no longer current.
        refused = await client.post('/v1/knowledge/commits', json={
            'space_id': space_id, 'personal_project_id': 'alpha', 'episode': {
                'idempotency_key': f'derived-{uuid4()}', 'session_id': 'synthetic-session', 'name': 'Synthetic',
                'source_kind': 'task_remember', 'source_description': 'Synthetic.', 'source_application': 'codex',
                'reference_time': '2026-10-21T00:00:00Z', 'entities': [{**fact, 'key': 'late'}]}})
        assert refused.status_code == 422 and refused.json()['detail']['code'] == 'derived_from_not_current'


@pytest.mark.asyncio
async def test_c8_4_a_personal_global_preference_rests_on_the_project_preferences_its_decision_named():
    """The existing derivation link: an approved personal-global decision names
    the project preferences it was concluded from. Seeded as stored."""
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        sources = []
        for project in ['alpha', 'beta']:
            source_id = (await commit(client, space_id, [preference('docs', 'Docs in Markdown')],
                                      project=project))['entity_ids'][0]
            await confirm(client, space_id, source_id)
            sources.append({'item_id': source_id, 'item_kind': 'entity', 'project_id': project})
        assertion_id = (await commit(client, space_id, [preference('docs-global', 'Docs in Markdown everywhere')]))[
            'entity_ids'][0]
        await confirm(client, space_id, assertion_id)
        event_id = str(uuid4())
        await query(settings, '''
            CREATE (:FuliPersonalGlobalPreferenceDecision {space_id: $space, candidate_id: $candidate,
              decision: 'approved', global_assertion_id: $assertion, current_event_id: $event})
            CREATE (:FuliPersonalGlobalPreferenceDecisionEvent {space_id: $space, id: $event,
              candidate_id: $candidate, global_assertion_id: $assertion, source_items_json: $sources})
            ''', space=space_id, candidate=f'candidate-{uuid4()}', assertion=assertion_id, event=event_id,
            sources=json.dumps(sources))
        assert {basis['item_id'] for basis in (await view(client, space_id, assertion_id))['bases']} == {
            source['item_id'] for source in sources}
        assert assertion_id in await applied(client, space_id, 'beta')
        first = sources[0]['item_id']
        ok(await mark_outdated(client, space_id, first, version=(await view(client, space_id, first))['version']))
        assertion = await view(client, space_id, assertion_id)
        assert assertion['status'] == 'basis_outdated'
        assert assertion_id not in await applied(client, space_id, 'beta')


@pytest.mark.asyncio
async def test_a_rejected_preference_keeps_its_block_through_an_agent_rewrite_but_not_a_persons_edit():
    """#225's block survives an Agent's new version; a person's own words lift it."""
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = (await commit(client, space_id, [
            preference('rhetoric', 'Use dramatic parallelism', content_source='agent_inferred')]))['entity_ids'][0]
        await promote_by_usage(client, space_id, item_id)
        ok(await client.post('/v1/knowledge/feedback', json={
            'personal_space_id': space_id, 'task_id': 'synthetic-rejection', 'items': [{
                'item_id': item_id, 'item_kind': 'entity', 'feedback_kind': 'rejected',
                'reason': 'That was a client brief, not my taste.', 'evidence_summary': 'The user said so.',
                'reported_by_kind': 'user'}]}))
        rejected = await view(client, space_id, item_id)
        rewrite_id = ok(await edit(client, space_id, item_id, 'Use parallelism sparingly',
                                   version=rejected['version'], actor='agent'))['version_item_id']
        [state] = await query(settings, 'MATCH (item:Entity {uuid: $item}) '
                              'RETURN item.fuli_negative_feedback_block_json AS block', item=rewrite_id)
        assert json.loads(state['block'])['reported_by_kind'] == 'user'
        await promote_by_usage(client, space_id, rewrite_id)
        assert (await view(client, space_id, rewrite_id))['confirmation_status'] == 'pending'
        assert rewrite_id not in await applied(client, space_id, 'alpha')
        own_id = ok(await edit(client, space_id, rewrite_id, 'Keep my own novels restrained',
                               version=(await view(client, space_id, rewrite_id))['version']))['version_item_id']
        [state] = await query(settings, 'MATCH (item:Entity {uuid: $item}) RETURN '
                              'item.fuli_negative_feedback_block_json AS block, '
                              'item.fuli_human_change_status AS human', item=own_id)
        assert state == {'block': None, 'human': 'unseen'}
        assert own_id in await applied(client, space_id, 'alpha')


@pytest.mark.asyncio
async def test_a_conflict_merge_writes_the_merged_words_as_a_new_version_the_other_points_at():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        ids = []
        for key, text in [('style-a', 'Reports start with a summary'), ('style-b', 'Reports start with the data')]:
            item_id = (await commit(client, space_id, [preference(
                key, text, attributes={'preferenceKey': 'report-opening'})]))['entity_ids'][0]
            await confirm(client, space_id, item_id)
            ids.append(item_id)
        left, right = sorted(ids)
        context = ok(await client.get('/v1/collaboration-preferences', params={
            'personal_space_id': space_id, 'personal_project_id': 'alpha'}))
        assert context['conflicts'] and set(context['conflicts'][0]['item_ids']) == set(ids)
        deferred = ok(await client.post('/v1/preference-conflicts/defer', json={
            'personal_space_id': space_id, 'conflict_id': f'synthetic-{uuid4()}', 'preference_key': 'report-opening',
            'preference_scope': 'global', 'left_item_id': left, 'left_item_kind': 'entity',
            'right_item_id': right, 'right_item_kind': 'entity', 'reason': 'Let the AI merge them.'}))
        ok(await client.post(f"/v1/preference-conflicts/{deferred['id']}/resolve", json={
            'personal_space_id': space_id, 'resolution': 'merge', 'reason': 'Both are true in order.',
            'canonical_item_id': left, 'merged_instruction': 'Reports start with a summary, then the data'}))
        canonical = await view(client, space_id, left)
        merged_id = canonical['current_item_id']
        assert canonical['status'] == 'superseded' and merged_id not in ids
        merged = await view(client, space_id, merged_id)
        assert merged['content'] == 'Reports start with a summary, then the data'
        assert merged['confirmation_status'] == 'confirmed'
        other = await view(client, space_id, right)
        assert other['invalid_at'] is not None
        [state] = await query(settings, 'MATCH (item:Entity {uuid: $item}) '
                              'RETURN item.fuli_replaced_by_item_id AS replacement', item=right)
        assert state['replacement'] == merged_id
        assert await entry_instructions(client, space_id, 'alpha') == {
            merged_id: 'Reports start with a summary, then the data'}


@pytest.mark.asyncio
async def test_a_relationship_is_versioned_and_marked_outdated_the_same_way():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        endpoints = [{'key': 'writer', 'name': 'Synthetic writer', 'type': 'Person'},
                     {'key': 'format', 'name': 'Report format', 'type': 'Format'}]
        relation = {'key': 'prefers-format', 'source': 'writer', 'target': 'format', 'type': 'PREFERS',
                    'fact': 'Reports are written in Word', 'profile_aspect': 'taste'}
        saved = await commit(client, space_id, endpoints, relationships=[relation])
        old_id = saved['relationship_ids'][0]
        await confirm(client, space_id, old_id, kind='relationship')
        assert old_id in await applied(client, space_id, 'alpha')
        before = await view(client, space_id, old_id, 'relationship')
        new_id = ok(await edit(client, space_id, old_id, 'Reports are written in Markdown', version=before['version'],
                               kind='relationship'))['version_item_id']
        assert await entry_instructions(client, space_id, 'alpha') == {new_id: 'Reports are written in Markdown'}
        old = await view(client, space_id, old_id, 'relationship')
        assert (old['status'], old['content'], old['current_item_id']) == (
            'superseded', 'Reports are written in Word', new_id)
        current = await view(client, space_id, new_id, 'relationship')
        assert current['evidence'][0]['source_kind'] == 'human_knowledge_edit'
        ok(await mark_outdated(client, space_id, new_id, version=current['version'], kind='relationship'))
        assert new_id not in await applied(client, space_id, 'alpha')
        assert (await view(client, space_id, new_id, 'relationship'))['status'] == 'outdated'
        edge = [edge for edge in ok(await client.get(f'/v1/spaces/{space_id}/graph', params={'limit': 500}))['edges']
                if edge['id'] == new_id]
        assert edge[0]['version_status'] == 'outdated'


async def stored(settings, item_id):
    [row] = await query(settings, '''
        MATCH (item:Entity {uuid: $item})
        OPTIONAL MATCH (episode:Episodic)-[:MENTIONS]->(item)
        RETURN properties(item) AS properties, count(episode) AS mentions
        ''', item=item_id)
    return row


@pytest.mark.asyncio
async def test_d20_6_a_same_key_capture_after_an_edit_lands_on_the_new_version_and_leaves_history_alone():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        words = preference('reply-language', 'Reply in English', content_source='agent_inferred')
        old_id = (await commit(client, space_id, [words]))['entity_ids'][0]
        await confirm(client, space_id, old_id)
        new_id = ok(await edit(client, space_id, old_id, 'Keep terms in English, the rest in Chinese',
                               version=(await view(client, space_id, old_id))['version']))['version_item_id']
        before = await stored(settings, old_id)
        later = await commit(client, space_id, [words], key=f'later-{uuid4()}')
        assert later['entity_ids'] == [new_id], 'the capture lands on the head of the chain'
        after = await stored(settings, old_id)
        assert after == before, 'a replaced version is never changed and gains no mentions'
        current = await view(client, space_id, new_id)
        assert later['episode_id'] in {source['episode_id'] for source in current['evidence']}
        assert current['content'] == 'Keep terms in English, the rest in Chinese'
        assert await entry_instructions(client, space_id, 'alpha') == {
            new_id: 'Keep terms in English, the rest in Chinese'}


@pytest.mark.asyncio
async def test_d20_10_an_agent_cannot_end_what_a_person_confirmed_only_report_it():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = (await commit(client, space_id, [preference('weekly-report', 'Weekly reports in Word')]))[
            'entity_ids'][0]
        await confirm(client, space_id, item_id)
        fact = {'key': 'template', 'name': 'The template is a .docx file', 'type': 'ProjectFact',
                'summary': 'The template is a .docx file', 'derived_from': [item_id]}
        fact_id = (await commit(client, space_id, [fact], project='alpha'))['entity_ids'][0]
        reported = ok(await mark_outdated(client, space_id, item_id, actor='agent',
                                          version=(await view(client, space_id, item_id))['version']))
        assert (reported['outcome'], reported['dependents_outdated']) == ('pending_person', 0)
        still = await view(client, space_id, item_id)
        assert (still['status'], still['confirmation_status']) == ('current', 'confirmed')
        assert still['weight']['basis']['negative_evidence_count'] == 1
        assert 'mark_outdated' not in {revision['action'] for revision in still['revisions']}
        assert item_id in await applied(client, space_id, 'alpha')
        assert (await view(client, space_id, fact_id))['status'] == 'current'
        # The console is the person: it ends validity.
        ok(await mark_outdated(client, space_id, item_id, version=still['version']))
        assert (await view(client, space_id, item_id))['status'] == 'outdated'
        assert (await view(client, space_id, fact_id))['status'] == 'basis_outdated'
        # What usage alone confirmed keeps the Agent path.
        inferred = (await commit(client, space_id, [preference(
            'headings', 'Use many headings', content_source='agent_inferred')]))['entity_ids'][0]
        await promote_by_usage(client, space_id, inferred)
        ended = ok(await mark_outdated(client, space_id, inferred, actor='agent',
                                       version=(await view(client, space_id, inferred))['version']))
        assert ended['outcome'] == 'applied'
        assert (await view(client, space_id, inferred))['status'] == 'outdated'


@pytest.mark.asyncio
async def test_a_reasserted_version_rests_only_on_bases_that_are_current():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        bases = []
        for key, text in [('word', 'Reports in Word'), ('share', 'Reports live on the share')]:
            base_id = (await commit(client, space_id, [preference(key, text)]))['entity_ids'][0]
            await confirm(client, space_id, base_id)
            bases.append(base_id)
        word, share = bases
        fact = {'key': 'template', 'name': 'The template is share/report.docx', 'type': 'ProjectFact',
                'summary': 'The template is share/report.docx', 'derived_from': bases}
        fact_id = (await commit(client, space_id, [fact], project='alpha'))['entity_ids'][0]
        share_v2 = ok(await edit(client, space_id, share, 'Reports live on the team drive',
                                 version=(await view(client, space_id, share))['version']))['version_item_id']
        ok(await mark_outdated(client, space_id, word, version=(await view(client, space_id, word))['version']))
        derived = await view(client, space_id, fact_id)
        assert derived['status'] == 'basis_outdated'
        reasserted = ok(await edit(client, space_id, fact_id, 'The template is share/report.docx',
                                   version=derived['version'], reason='Still true for the old reports'))
        current = await view(client, space_id, reasserted['version_item_id'])
        assert [basis['item_id'] for basis in current['bases']] == [share_v2], (
            'the outdated basis is dropped; the edited one is followed to its current version')
        assert current['bases'][0]['status'] == 'current'


@pytest.mark.asyncio
async def test_d20_5_editing_a_deactivated_item_writes_a_new_version_and_restore_still_works():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = (await commit(client, space_id, [preference('tone', 'Keep a calm tone')]))['entity_ids'][0]
        await confirm(client, space_id, item_id)
        ok(await client.patch(f'/v1/knowledge/items/{item_id}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'invalidate',
            'reason': 'Paused for now.', 'operation_actor': 'human',
            'expected_version': (await view(client, space_id, item_id))['version']}))
        inactive = await view(client, space_id, item_id)
        assert inactive['status'] == 'inactive'
        new_id = ok(await edit(client, space_id, item_id, 'Keep a calm, direct tone',
                               version=inactive['version']))['version_item_id']
        assert new_id and new_id != item_id
        old = await view(client, space_id, item_id)
        assert (old['content'], old['invalid_at']) == ('Keep a calm tone', inactive['invalid_at'])
        assert new_id in await applied(client, space_id, 'alpha')
        other = (await commit(client, space_id, [preference('brevity', 'Be brief')]))['entity_ids'][0]
        await confirm(client, space_id, other)
        ok(await client.patch(f'/v1/knowledge/items/{other}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'invalidate', 'reason': 'Paused.',
            'operation_actor': 'human', 'expected_version': (await view(client, space_id, other))['version']}))
        ok(await client.patch(f'/v1/knowledge/items/{other}', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'restore', 'reason': 'Back on.',
            'operation_actor': 'human', 'expected_version': (await view(client, space_id, other))['version']}))
        assert (await view(client, space_id, other))['status'] == 'current'
