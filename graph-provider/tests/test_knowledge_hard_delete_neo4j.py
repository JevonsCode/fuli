"""rec#5 C9 (hard delete) against an explicitly disposable Neo4j. Synthetic
people, preferences and projects only; public HTTP routes drive every write.
The value standing in for a pasted key is synthetic and not a credential."""

import asyncio
from uuid import uuid4

import pytest

from fuli_graph import knowledge_hard_delete
from test_knowledge_basis_review_neo4j import revise
from test_knowledge_versions_neo4j import edit
from test_negative_feedback_block_neo4j import query, use
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import applied, commit, confirm, ok, preference, receipt, space_with_projects, view

REVIEW_TOKEN = 'synthetic-hard-delete-review-token-0123456789'
REVIEW = {'x-fuli-human-review-token': REVIEW_TOKEN}
PASTED = 'SYNTHETIC-PASTED-KEY-0000-not-a-real-secret'
TRACE_KEYS = {'id', 'space_id', 'item_id', 'item_kind', 'action', 'operation', 'operation_actor', 'outcome',
              'created_by', 'created_at', 'deleted_item_keys', 'evidence_ids', 'removed_episode_ids',
              'deletion_counts_json'}


def reviewed():
    return fixture_settings().model_copy(update={'human_review_token': REVIEW_TOKEN})


async def preview(client, space_id, item_id, kind='entity', headers=REVIEW):
    return await client.post(f'/v1/knowledge/items/{item_id}/hard-delete/preview',
                             json={'personal_space_id': space_id, 'item_kind': kind}, headers=headers)


async def delete(client, space_id, item_id, preview_id, *, kind='entity', confirmation='删除', headers=REVIEW):
    return await client.post(f'/v1/knowledge/items/{item_id}/hard-delete', json={
        'personal_space_id': space_id, 'item_kind': kind, 'preview_id': preview_id,
        'confirmation': confirmation}, headers=headers)


async def seeded(client):
    """A preference that kept a pasted key, in a turn it shares with another
    fact (and a relationship between them), mentioned again alone in a second
    turn, then edited into a new version with a tag and a use. Two preferences
    are concluded from it, one from the other."""
    space_id = await space_with_projects(client, 'alpha')
    shared = await commit(client, space_id, [
        preference('deploy-config', f'Deploy with {PASTED}'),
        {'key': 'deploy-target', 'name': 'Synthetic staging target', 'type': 'ProjectFact',
         'summary': 'Synthetic staging target'}],
        relationships=[{'key': 'deploys-to', 'source': 'deploy-config', 'target': 'deploy-target',
                        'type': 'DEPLOYS_TO', 'fact': f'{PASTED} deploys to staging'}])
    old_id, other_id = shared['entity_ids']
    own_key = f'own-{uuid4()}'
    own = await commit(client, space_id, [preference('deploy-config', f'Deploy with {PASTED}')], key=own_key)
    assert own['entity_ids'] == [old_id]
    await confirm(client, space_id, old_id)
    new_id = ok(await edit(client, space_id, old_id, f'Deploy with {PASTED} (rotated)',
                           version=(await view(client, space_id, old_id))['version']))['version_item_id']
    tag = ok(await client.post('/v1/knowledge-tags/create', json={
        'personal_space_id': space_id, 'name': 'deploy', 'namespace': 'personal', 'reason': 'Synthetic tag.',
        'operation_actor': 'human'}))['tag']
    ok(await client.post('/v1/knowledge-tags/attach', json={
        'personal_space_id': space_id, 'tag_id': tag['id'], 'item_kind': 'entity', 'item_id': new_id,
        'operation_actor': 'human'}))
    await use(client, space_id, 'synthetic-task-1', new_id)
    conclusion = (await commit(client, space_id, [preference(
        'deploy-checks', 'Run the smoke checks after every deploy', derived_from=[new_id])]))['entity_ids'][0]
    await confirm(client, space_id, conclusion)
    follow = (await commit(client, space_id, [preference(
        'deploy-report', 'Post the smoke check summary', derived_from=[conclusion])]))['entity_ids'][0]
    await confirm(client, space_id, follow)
    edit_episode = (await view(client, space_id, new_id))['evidence'][0]['episode_id']
    return {'space_id': space_id, 'old': old_id, 'new': new_id, 'other': other_id,
            'relationship': shared['relationship_ids'][0], 'shared_episode': shared['episode_id'],
            'own_episode': own['episode_id'], 'own_key': own_key, 'edit_episode': edit_episode,
            'conclusion': conclusion, 'follow': follow}


async def space_properties(settings, space_id):
    """Every stored property value of the space's nodes and relationships, as text."""
    rows = await query(settings, '''
        MATCH (space:FuliSpace {id: $space_id})
        CALL {
          WITH space
          MATCH (n) WHERE n.group_id = space.group_id OR n.space_id = space.id OR n.personal_space_id = space.id
          RETURN properties(n) AS values
          UNION ALL
          WITH space
          MATCH ()-[r]->() WHERE r.group_id = space.group_id
          RETURN properties(r) AS values
        }
        RETURN values
    ''', space_id=space_id)
    return '\n'.join(sorted(repr(sorted(row['values'].items())) for row in rows))


@pytest.mark.asyncio
async def test_no_agent_or_mcp_route_can_preview_or_delete_only_the_human_review_channel():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        item = await seeded(client)
        space_id = item['space_id']
        # The access token every MCP and Agent tool path uses is not enough.
        assert (await preview(client, space_id, item['new'], headers={})).status_code == 403
        assert (await preview(client, space_id, item['new'], headers={
            'x-fuli-human-review-token': 'synthetic-wrong-token-000000000000'})).status_code == 403
        real = ok(await preview(client, space_id, item['new']))
        refused = await delete(client, space_id, item['new'], real['preview_id'], headers={})
        assert refused.status_code == 403
        assert (await view(client, space_id, item['new']))['status'] == 'current'
    # Without a configured channel nothing can delete at all.
    async with provider_client(fixture_settings().model_copy(update={'human_review_token': None})) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        saved = (await commit(client, space_id, [preference('lonely', 'Synthetic lonely')]))['entity_ids'][0]
        assert (await preview(client, space_id, saved)).status_code == 503


@pytest.mark.asyncio
async def test_c9_the_preview_lists_exactly_what_goes_what_stays_and_what_rests_on_it():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        item = await seeded(client)
        plan = ok(await preview(client, item['space_id'], item['new']))
        assert [(row['role'], row['item_id'], row['status']) for row in plan['items']] == [
            ('item', item['new'], 'current'), ('version', item['old'], 'superseded'),
            ('relationship', item['relationship'], 'current')]
        assert plan['title'].startswith('Deploy with')
        # The second turn and the edit's own episode are used by nothing else.
        assert sorted(row['episode_id'] for row in plan['removed_episodes']) == sorted(
            [item['own_episode'], item['edit_episode']])
        assert all(row['other_items'] == 0 for row in plan['removed_episodes'])
        # The shared turn stays: it also recorded the staging target.
        [kept] = plan['kept_episodes']
        assert kept['episode_id'] == item['shared_episode'] and kept['other_items'] == 1
        # It names what still uses it, so the person can open (and delete) that too.
        assert kept['used_by'] == [{'item_kind': 'entity', 'item_id': item['other'],
                                    'title': 'Synthetic staging target'}]
        assert all(row['used_by'] == [] for row in plan['removed_episodes'])
        assert [(row['item_id'], row['direct']) for row in plan['dependents']] == [
            (item['conclusion'], True), (item['follow'], False)]
        counts = plan['counts']
        assert {key: counts[key] for key in ('items', 'versions', 'relationships', 'episodes', 'kept_episodes',
                                             'mentions', 'tags', 'usage', 'dependents')} == {
            'items': 3, 'versions': 2, 'relationships': 1, 'episodes': 2, 'kept_episodes': 1,
            'mentions': 3, 'tags': 1, 'usage': 1, 'dependents': 2}
        assert counts['revisions'] >= 2 and counts['change_audits'] >= 1
        # A preview reads; it changes nothing and is the same when read again.
        assert ok(await preview(client, item['space_id'], item['new']))['preview_id'] == plan['preview_id']


@pytest.mark.asyncio
async def test_c9_a_stale_preview_or_a_missing_confirmation_deletes_nothing():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        item = await seeded(client)
        space_id = item['space_id']
        plan = ok(await preview(client, space_id, item['new']))
        # A new use after the preview changes what would go.
        await use(client, space_id, 'synthetic-task-2', item['new'])
        stale = await delete(client, space_id, item['new'], plan['preview_id'])
        assert stale.status_code == 409 and stale.json()['detail']['code'] == 'hard_delete_preview_stale'
        fresh = ok(await preview(client, space_id, item['new']))
        assert fresh['preview_id'] != plan['preview_id'] and fresh['counts']['usage'] == 2
        unconfirmed = await delete(client, space_id, item['new'], fresh['preview_id'], confirmation='ok')
        assert unconfirmed.status_code == 422 and unconfirmed.json()['detail']['code'] == 'hard_delete_unconfirmed'
        assert (await view(client, space_id, item['new']))['status'] == 'current'
        assert ok(await preview(client, space_id, item['new']))['preview_id'] == fresh['preview_id']
        # The title confirms as well as 删除.
        assert ok(await delete(client, space_id, item['new'], fresh['preview_id'],
                               confirmation=fresh['title']))['item_id'] == item['new']


@pytest.mark.asyncio
async def test_c9_a_delete_removes_every_copy_keeps_the_shared_turn_and_holds_what_rests_on_it():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        item = await seeded(client)
        space_id = item['space_id']
        assert {item['conclusion'], item['follow']} <= await applied(client, space_id, 'alpha')
        plan = ok(await preview(client, space_id, item['new']))
        done = ok(await delete(client, space_id, item['new'], plan['preview_id']))
        assert sorted(done['deleted_item_ids']) == sorted([item['new'], item['old'], item['relationship']])
        assert done['counts'] == plan['counts'] and done['deleted_by'] == 'user'
        gone = [item['new'], item['old'], item['relationship']]
        # Old links to any version or to the relationship say it was deleted.
        for item_id, kind in [(item['new'], 'entity'), (item['old'], 'entity'), (item['relationship'], 'relationship')]:
            response = await client.post('/v1/knowledge/item-views', json={
                'personal_space_id': space_id, 'item_kind': kind, 'item_id': item_id})
            assert response.status_code == 410, response.text
            assert response.json()['detail']['code'] == 'hard_deleted'
        # Nothing about it is left: items, own episodes, records.
        assert await query(settings, '''
            MATCH (n) WHERE n.uuid IN $ids OR (n:Episodic AND n.uuid IN $episodes) RETURN n.uuid AS id
            UNION
            MATCH ()-[r:RELATES_TO]->() WHERE r.uuid IN $ids RETURN r.uuid AS id
            UNION
            MATCH (n) WHERE n.item_id IN $ids AND (n:FuliKnowledgeRevision OR n:FuliKnowledgeTagLink
                OR n:FuliKnowledgeAssignment OR n:FuliKnowledgeProjectReference
                OR (n:FuliKnowledgeAudit AND n.action <> 'hard_delete'))
            RETURN n.id AS id
        ''', ids=gone, episodes=[item['own_episode'], item['edit_episode']]) == []
        assert PASTED not in await space_properties(settings, space_id)
        # The shared turn stays for the staging target, without what went.
        [shared] = await query(settings, '''
            MATCH (episode:Episodic {uuid: $id})
            OPTIONAL MATCH (episode)-[:MENTIONS]->(entity:Entity)
            RETURN episode.entity_edges AS edges, collect(entity.uuid) AS mentioned
        ''', id=item['shared_episode'])
        assert shared == {'edges': [], 'mentioned': [item['other']]}
        assert (await view(client, space_id, item['other']))['status'] == 'current'
        # The content-free trace: ids, time, the person, kind and counts only.
        [trace] = await query(settings, '''
            MATCH (trace:FuliKnowledgeAudit {space_id: $space_id, action: 'hard_delete'})
            RETURN properties(trace) AS values
        ''', space_id=space_id)
        trace = trace['values']
        assert set(trace) == TRACE_KEYS and trace['operation_actor'] == 'human'
        assert sorted(trace['deleted_item_keys']) == sorted(
            [f'entity:{item["new"]}', f'entity:{item["old"]}', f'relationship:{item["relationship"]}'])
        assert 'Deploy' not in repr(trace) and PASTED not in repr(trace)
        # What rested on it waits for the person and is not delivered.
        delivered = await applied(client, space_id, 'alpha')
        assert item['conclusion'] not in delivered and item['follow'] not in delivered
        conclusion = await view(client, space_id, item['conclusion'])
        assert conclusion['basis_review'] == 'changed' and conclusion['confirmation_status'] == 'confirmed'
        assert conclusion['bases'] == [
            {'item_kind': 'entity', 'item_id': item['new'], 'content': '', 'status': 'deleted'}]
        [held] = [row for row in conclusion['revisions'] if row['action'] == 'basis_changed']
        assert held['reason'] == knowledge_hard_delete.DEPENDENT_REASON and PASTED not in repr(held)
        assert (await view(client, space_id, item['follow']))['basis_review'] == 'changed'
        # Receipts of either turn say something was deleted.
        own = await receipt(client, space_id, item['own_episode'])
        assert own == {'entries': [], 'unchanged_count': 0, 'deleted_count': 1, 'deletion_ids': [done['deletion_id']]}
        shared_receipt = await receipt(client, space_id, item['shared_episode'])
        assert shared_receipt['deletion_ids'] == [done['deletion_id']]
        assert [entry['item_id'] for entry in shared_receipt['entries']] == [item['other']]
        # A replay of the removed turn's capture does not write it again.
        replay = await commit(client, space_id, [preference('deploy-config', f'Deploy with {PASTED}')],
                              key=item['own_key'])
        assert replay['status'] == 'duplicate' and replay['entity_ids'] == []
        assert PASTED not in await space_properties(settings, space_id)
        # A person's review ("仍然成立") releases the conclusion, now resting on nothing deleted.
        reviewed_conclusion = ok(await revise(client, space_id, item['conclusion'], 'reaffirm'))
        assert reviewed_conclusion['version_item_id'] in await applied(client, space_id, 'alpha')
        # A second delete of the same item is answered from the trace.
        again = await preview(client, space_id, item['new'])
        assert again.status_code == 410 and again.json()['detail']['code'] == 'hard_deleted'


@pytest.mark.asyncio
async def test_c9_a_relationship_goes_alone_and_both_ends_and_their_turn_stay():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        saved = await commit(client, space_id, [
            {'key': 'writer', 'name': 'Synthetic writer', 'type': 'Person'},
            {'key': 'format', 'name': 'Report format', 'type': 'Format'}],
            relationships=[{'key': 'prefers-format', 'source': 'writer', 'target': 'format', 'type': 'PREFERS',
                            'fact': f'Reports carry {PASTED}', 'profile_aspect': 'taste'}])
        relationship = saved['relationship_ids'][0]
        plan = ok(await preview(client, space_id, relationship, kind='relationship'))
        assert [(row['role'], row['item_id']) for row in plan['items']] == [('item', relationship)]
        assert plan['removed_episodes'] == [] and plan['kept_episodes'][0]['episode_id'] == saved['episode_id']
        ok(await delete(client, space_id, relationship, plan['preview_id'], kind='relationship'))
        for entity in saved['entity_ids']:
            assert (await view(client, space_id, entity))['status'] == 'current'
        [episode] = await query(settings, 'MATCH (e:Episodic {uuid: $id}) RETURN e.entity_edges AS edges',
                                id=saved['episode_id'])
        assert episode == {'edges': []}
        assert PASTED not in await space_properties(settings, space_id)


@pytest.mark.asyncio
async def test_c9_a_failure_before_the_commit_rolls_everything_back(monkeypatch):
    settings = reviewed()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        item = await seeded(client)
        space_id = item['space_id']
        plan = ok(await preview(client, space_id, item['new']))
        before = await space_properties(settings, space_id)

        async def fail(*_args, **_kwargs):
            raise RuntimeError('synthetic failure after every removal, before the trace')

        monkeypatch.setattr(knowledge_hard_delete, '_write_trace', fail)
        failed = await delete(client, space_id, item['new'], plan['preview_id'])
        assert failed.status_code == 500
        # Every removal and the dependents' hold rolled back with it.
        assert await space_properties(settings, space_id) == before
        assert (await view(client, space_id, item['new']))['status'] == 'current'
        assert (await view(client, space_id, item['conclusion']))['basis_review'] is None
        assert ok(await preview(client, space_id, item['new']))['preview_id'] == plan['preview_id']
        monkeypatch.undo()
        ok(await delete(client, space_id, item['new'], plan['preview_id']))
        assert PASTED not in await space_properties(settings, space_id)


async def status(client, space_id, item_id, kind='entity', headers=REVIEW):
    return await client.post(f'/v1/knowledge/items/{item_id}/hard-delete/status',
                             json={'personal_space_id': space_id, 'item_kind': kind}, headers=headers)


@pytest.mark.asyncio
async def test_dot_p1_1_saying_a_deleted_key_again_is_a_new_item_and_the_deleted_id_stays_deleted():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        first = (await commit(client, space_id, [preference('deploy-config', f'Deploy with {PASTED}')]))['entity_ids'][0]
        await confirm(client, space_id, first)
        conclusion = (await commit(client, space_id, [preference(
            'deploy-checks', 'Run the smoke checks after every deploy', derived_from=[first])]))['entity_ids'][0]
        await confirm(client, space_id, conclusion)
        done = ok(await delete(client, space_id, first, ok(await preview(client, space_id, first))['preview_id']))
        # A new statement of the same key, from a new turn, after the delete.
        again = await commit(client, space_id, [preference('deploy-config', 'Deploy through the staging gate')])
        [second] = again['entity_ids']
        assert again['status'] == 'committed' and second != first
        # The old link stays 已彻底删除 and the old basis stays deleted.
        old = await client.post('/v1/knowledge/item-views', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'item_id': first})
        assert old.status_code == 410 and old.json()['detail']['code'] == 'hard_deleted'
        assert (await view(client, space_id, conclusion))['bases'] == [
            {'item_kind': 'entity', 'item_id': first, 'content': '', 'status': 'deleted'}]
        assert (await query(settings, 'MATCH (n:Entity {uuid: $id}) RETURN n.uuid AS id', id=first)) == []
        # The new item is its own, fully usable: read, confirmed, delivered, derived from.
        current = await view(client, space_id, second)
        assert (current['status'], current['content']) == ('current', 'Deploy through the staging gate')
        await confirm(client, space_id, second)
        assert second in await applied(client, space_id, 'alpha')
        derived = await commit(client, space_id, [preference('deploy-notes', 'Note the gate result', derived_from=[second])])
        assert derived['status'] == 'committed'
        # A conclusion cannot name the deleted ID as a basis, even now that the key lives again.
        refused = await client.post('/v1/knowledge/commits', json={
            'space_id': space_id, 'episode': {
                'idempotency_key': f'late-{uuid4()}', 'session_id': 'synthetic-session', 'name': 'Synthetic',
                'source_kind': 'task_remember', 'source_description': 'Synthetic.', 'source_application': 'codex',
                'reference_time': '2026-10-21T00:00:00Z',
                'entities': [preference('late', 'Late conclusion', derived_from=[first])]}})
        assert refused.status_code == 422 and refused.json()['detail']['code'] == 'derived_from_not_current'
        # Deleting the new item and saying the key a third time gives a third identity.
        ok(await delete(client, space_id, second, ok(await preview(client, space_id, second))['preview_id']))
        [third] = (await commit(client, space_id, [preference('deploy-config', 'Deploy on Fridays')]))['entity_ids']
        assert third not in (first, second)
        for gone in (first, second):
            assert (await client.post('/v1/knowledge/item-views', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'item_id': gone})).status_code == 410
        # The status a console asks when its answer was lost: from the trace, never a second delete.
        settled = ok(await status(client, space_id, first))
        assert settled['state'] == 'deleted' and settled['deletion']['deletion_id'] == done['deletion_id']
        assert settled['deletion']['deleted_item_ids'] == [first]
        assert ok(await status(client, space_id, third))['state'] == 'present'
        assert ok(await status(client, space_id, 'synthetic-missing'))['state'] == 'missing'
        assert (await status(client, space_id, first, headers={})).status_code == 403


async def operation(client, space_id, operation_id, *, abort=False):
    return ok(await client.post(f'/v1/knowledge/hard-delete-operations/{operation_id}{"/abort" if abort else ""}',
                                json={'personal_space_id': space_id}, headers=REVIEW))


@pytest.mark.asyncio
async def test_dot_round3_a_held_delete_is_unknown_until_it_commits_and_an_abort_waits_for_it(monkeypatch):
    """A real hold: the delete's transaction (with the space lock) is held for
    a second past the moment its console gave up. Its outcome stays unknown,
    and an abort sent meanwhile waits for the lock and answers committed."""
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        item = await seeded(client)
        space_id = item['space_id']
        plan = ok(await preview(client, space_id, item['new']))
        entered, release = asyncio.Event(), asyncio.Event()
        original = knowledge_hard_delete._write_trace

        async def held(*args, **kwargs):
            entered.set()
            await release.wait()
            return await original(*args, **kwargs)

        monkeypatch.setattr(knowledge_hard_delete, '_write_trace', held)
        operation_id = str(uuid4())
        deleting = asyncio.create_task(client.post(f'/v1/knowledge/items/{item["new"]}/hard-delete', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'preview_id': plan['preview_id'],
            'confirmation': '删除', 'operation_id': operation_id}, headers=REVIEW))
        await asyncio.wait_for(entered.wait(), 30)
        assert (await operation(client, space_id, operation_id))['state'] == 'unknown'
        aborting = asyncio.create_task(operation(client, space_id, operation_id, abort=True))
        await asyncio.sleep(1.0)
        assert not aborting.done(), 'the abort waits for the delete that holds the lock'
        assert (await operation(client, space_id, operation_id))['state'] == 'unknown'
        release.set()
        done = ok(await deleting)
        aborted = await asyncio.wait_for(aborting, 30)
        assert aborted['state'] == 'committed' and aborted['deletion']['deletion_id'] == done['deletion_id']
        settled = await operation(client, space_id, operation_id)
        assert settled['state'] == 'committed' and settled['deletion']['deleted_item_ids'] == done['deleted_item_ids']
        listed = ok(await client.post('/v1/knowledge/hard-deletions', json={'personal_space_id': space_id},
                                      headers=REVIEW))
        assert [row['deletion_id'] for row in listed] == [done['deletion_id']]


@pytest.mark.asyncio
async def test_dot_round3_an_abort_that_comes_first_wins_and_a_refusal_is_recorded():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        item = await seeded(client)
        space_id = item['space_id']
        plan = ok(await preview(client, space_id, item['new']))
        # Aborted before its delete arrived: the late delete is refused under the same lock.
        early = str(uuid4())
        assert (await operation(client, space_id, early, abort=True))['state'] == 'aborted'
        late = await client.post(f'/v1/knowledge/items/{item["new"]}/hard-delete', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'preview_id': plan['preview_id'],
            'confirmation': '删除', 'operation_id': early}, headers=REVIEW)
        assert late.status_code == 409 and late.json()['detail']['code'] == 'hard_delete_aborted'
        assert (await view(client, space_id, item['new']))['status'] == 'current'
        assert (await operation(client, space_id, early))['state'] == 'aborted'
        # A refusal is that operation's durable answer.
        wrong = str(uuid4())
        refused = await client.post(f'/v1/knowledge/items/{item["new"]}/hard-delete', json={
            'personal_space_id': space_id, 'item_kind': 'entity', 'preview_id': plan['preview_id'],
            'confirmation': 'ok', 'operation_id': wrong}, headers=REVIEW)
        assert refused.status_code == 422
        assert (await operation(client, space_id, wrong)) == {
            'operation_id': wrong, 'state': 'refused', 'code': 'hard_delete_unconfirmed', 'deletion': None}
        # An abort after a refusal keeps the refusal; one never asked about is unknown.
        assert (await operation(client, space_id, wrong, abort=True))['state'] == 'refused'
        assert (await operation(client, space_id, str(uuid4())))['state'] == 'unknown'
        # Agents cannot ask about or abort an operation, or list deletions.
        for path in (f'/v1/knowledge/hard-delete-operations/{early}',
                     f'/v1/knowledge/hard-delete-operations/{early}/abort', '/v1/knowledge/hard-deletions'):
            assert (await client.post(path, json={'personal_space_id': space_id})).status_code == 403
