"""Triage labels on unclaimed conversations and topic accumulation; no LLM."""
from fastapi import HTTPException
from .conversation_scope import conversation_scope_id
from .graph_field_contract import stored_fields
from .knowledge_versions import lock_knowledge
from .provider_values import now_utc
from .store_transactions import query_store_transaction
from .system_agents import SYSTEM_ASSISTANT_AGENT_ID as ASSISTANT_AGENT_ID
from .topic_knowledge_migration import move_topic_knowledge, return_topic_knowledge


def topic_key(topic):
    return ' '.join(topic.split()).casefold()


class StoreConversationTriage:
    async def record_conversation_triage(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        if request.personal_project_id is not None:
            await self.get_personal_project(actor, request.personal_space_id, request.personal_project_id)
        key = topic_key(request.topic) if request.topic else None
        label = {'kind': request.kind, 'personal_project_id': request.personal_project_id,
                 'topic': ' '.join(request.topic.split()) if request.topic else None,
                 'topic_key': key, 'source': request.source, 'labeled_at': now_utc().isoformat()}
        # One statement. Only the assistant's global conversations are unclaimed;
        # project conversations already belong somewhere. Locking that existing
        # conversation first serializes every writer, including the first one,
        # since a label that does not exist yet has no lock of its own to take.
        # The label lock then orders writers against topic formation, so a
        # correction committed meanwhile is never overwritten by an older read.
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id, scope: $scope}) '
            'SET c._triage_lock = true REMOVE c._triage_lock '
            'MERGE (t:FuliConversationTriage {id: $id}) '
            'ON CREATE SET t.space_id=$space_id '
            'SET t._triage_lock = true REMOVE t._triage_lock '
            'WITH t, CASE WHEN $source <> "host" THEN null '
            "WHEN t.formed_project_id IS NOT NULL THEN 'formed_project' "
            "WHEN t.source = 'user' THEN 'user_label' ELSE null END AS kept "
            'FOREACH (_ IN CASE WHEN kept IS NULL THEN [1] ELSE [] END | SET t += $label) '
            'RETURN t, kept',
            id=request.conversation_id, space_id=space['id'],
            label=stored_fields('FuliConversationTriage', label), source=request.source,
            scope=conversation_scope_id(space['id'], None, ASSISTANT_AGENT_ID))
        if not rows:
            raise HTTPException(404, 'Unclaimed conversation not found')
        record, kept = dict(rows[0]['t']), rows[0]['kept']
        return {'triage': self._triage_view(record), **({'kept': kept} if kept else {}),
                'topic_count': await self._topic_count(space['id'], record.get('topic_key'))}
    async def _topic_count(self, space_id, key):
        if not key:
            return 0
        rows, _, _ = await self.runtime.driver.execute_query(
            "MATCH (t:FuliConversationTriage {space_id: $space_id, topic_key: $key, kind: 'topic'}) "
            'WHERE t.formed_project_id IS NULL RETURN count(t) AS count',
            space_id=space_id, key=key)
        return rows[0]['count'] if rows else 0

    async def query_conversation_topics(self, actor, request):
        """Open topics for the next triage, people's own labels first. Each says
        how many conversations and distinct days it spans, and how many it had
        when a person last said not yet, so a proposal is decided without a model."""
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            "MATCH (t:FuliConversationTriage {space_id: $space_id, kind: 'topic'}) "
            'WHERE t.formed_project_id IS NULL AND ($key IS NULL OR t.topic_key = $key) '
            'WITH t.topic_key AS key, collect(t.topic)[0] AS topic, count(t) AS total, '
            'count(DISTINCT substring(t.labeled_at, 0, 10)) AS days, '
            "max(CASE WHEN t.source = 'user' THEN 1 ELSE 0 END) AS by_user, max(t.labeled_at) AS last "
            'WHERE total >= $min_count '
            'OPTIONAL MATCH (d:FuliConversationTopicDecline {space_id: $space_id, topic_key: key}) '
            'RETURN topic, total AS count, days, last, d.declined_count AS declined_count '
            'ORDER BY by_user DESC, total DESC, last DESC LIMIT $limit',
            space_id=space['id'], limit=request.limit, min_count=request.min_count,
            key=topic_key(request.topic) if request.topic else None)
        return {'topics': [{'topic': row['topic'], 'count': row['count'], 'days': row['days'],
                            'last_labeled_at': row['last'], 'declined_count': row['declined_count']}
                           for row in rows]}

    async def decline_conversation_topic(self, actor, request):
        """A person said not yet; remember how many conversations the topic had then."""
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        key = topic_key(request.topic)
        count = await self._topic_count(space['id'], key)
        if not count:
            raise HTTPException(404, 'Open conversation topic not found')
        await self._remember_decline(space['id'], key, request.topic, count)
        return {'topic': ' '.join(request.topic.split()), 'declined_count': count}

    async def _remember_decline(self, space_id, key, topic, count):
        await self.runtime.driver.execute_query(
            'MERGE (d:FuliConversationTopicDecline {space_id: $space_id, topic_key: $key}) '
            'SET d.topic = $topic, d.declined_count = $count, d.declined_at = $now',
            space_id=space_id, key=key, topic=' '.join(topic.split()), count=count, now=now_utc().isoformat())

    async def form_conversation_topic(self, actor, request):
        """Attach every open conversation of a topic to its formed project, and
        move what their sessions hold into it (topic_knowledge_migration), in
        one transaction under the knowledge lock; idempotent."""
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await self.get_personal_project(actor, request.personal_space_id, request.personal_project_id)
        async with query_store_transaction(self) as scoped:
            await lock_knowledge(scoped, space)
            rows, _, _ = await scoped.runtime.driver.execute_query(
                "MATCH (t:FuliConversationTriage {space_id: $space_id, topic_key: $key, kind: 'topic'}) "
                'WHERE t.formed_project_id IS NULL OR t.formed_project_id = $project '
                'SET t.formed_project_id = $project, t.formed_at = coalesce(t.formed_at, $now) '
                'RETURN t.id AS id ORDER BY id',
                space_id=space['id'], key=topic_key(request.topic), project=request.personal_project_id,
                now=now_utc().isoformat())
            conversation_ids = [row['id'] for row in rows]
            knowledge = await move_topic_knowledge(scoped, actor, space, ' '.join(request.topic.split()),
                                                   request.personal_project_id, conversation_ids)
        return {'personal_project_id': request.personal_project_id, 'conversation_ids': conversation_ids,
                'knowledge': knowledge}

    async def reopen_conversation_topic(self, actor, request):
        """Undo a formation (rec#11 D-86): the topic's conversations formed into
        this project are open again, what their sessions' knowledge moved there
        and nobody changed since goes back, and the topic counts as declined at
        that size, so it is not formed or proposed again until it grows."""
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        key = topic_key(request.topic)
        async with query_store_transaction(self) as scoped:
            await lock_knowledge(scoped, space)
            rows, _, _ = await scoped.runtime.driver.execute_query(
                "MATCH (t:FuliConversationTriage {space_id: $space_id, topic_key: $key, kind: 'topic', "
                'formed_project_id: $project}) REMOVE t.formed_project_id, t.formed_at '
                'RETURN t.id AS id ORDER BY id',
                space_id=space['id'], key=key, project=request.personal_project_id)
            if not rows:
                raise HTTPException(404, 'No conversation of this topic was formed into this project')
            conversation_ids = [row['id'] for row in rows]
            knowledge = await return_topic_knowledge(scoped, actor, space, ' '.join(request.topic.split()),
                                                     request.personal_project_id, conversation_ids)
            count = await scoped._topic_count(space['id'], key)
            await scoped._remember_decline(space['id'], key, request.topic, count)
        return {'topic': ' '.join(request.topic.split()), 'personal_project_id': request.personal_project_id,
                'conversation_ids': conversation_ids, 'declined_count': count, 'knowledge': knowledge}

    async def read_conversation_triage(self, actor, request):
        """One conversation's current attribution state, or None: the label (kind,
        project, topic, source, labeled_at) and the project its topic was formed
        into, which forming sets without touching labeled_at or source."""
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (t:FuliConversationTriage {id: $id, space_id: $space_id}) RETURN t',
            id=request.conversation_id, space_id=space['id'], routing_='r')
        return {'triage': self._triage_view(dict(rows[0]['t'])) if rows else None}

    @staticmethod
    def _triage_view(record):
        return {key: record.get(key) for key in (
            'kind', 'personal_project_id', 'topic', 'source', 'labeled_at', 'formed_project_id')}
