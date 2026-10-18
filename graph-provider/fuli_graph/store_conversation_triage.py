"""Triage labels on unclaimed conversations and topic accumulation; no LLM."""
from fastapi import HTTPException
from .provider_values import now_utc, stable_uuid
from .system_agents import SYSTEM_ASSISTANT_AGENT_ID as ASSISTANT_AGENT_ID


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
            id=request.conversation_id, space_id=space['id'], label=label, source=request.source,
            scope=stable_uuid('global-conversation-scope', space['id'], ASSISTANT_AGENT_ID))
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
        """Open topic names for the next triage; people's own labels come first."""
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            "MATCH (t:FuliConversationTriage {space_id: $space_id, kind: 'topic'}) "
            'WHERE t.formed_project_id IS NULL '
            'WITH t.topic_key AS key, collect(t.topic)[0] AS topic, count(t) AS count, '
            "max(CASE WHEN t.source = 'user' THEN 1 ELSE 0 END) AS by_user, max(t.labeled_at) AS last "
            'RETURN topic, count ORDER BY by_user DESC, count DESC, last DESC LIMIT $limit',
            space_id=space['id'], limit=request.limit)
        return {'topics': [{'topic': row['topic'], 'count': row['count']} for row in rows]}

    async def form_conversation_topic(self, actor, request):
        """Attach every open conversation of a topic to its formed project; idempotent."""
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await self.get_personal_project(actor, request.personal_space_id, request.personal_project_id)
        rows, _, _ = await self.runtime.driver.execute_query(
            "MATCH (t:FuliConversationTriage {space_id: $space_id, topic_key: $key, kind: 'topic'}) "
            'WHERE t.formed_project_id IS NULL OR t.formed_project_id = $project '
            'SET t.formed_project_id = $project, t.formed_at = coalesce(t.formed_at, $now) '
            'RETURN t.id AS id ORDER BY id',
            space_id=space['id'], key=topic_key(request.topic), project=request.personal_project_id,
            now=now_utc().isoformat())
        return {'personal_project_id': request.personal_project_id,
                'conversation_ids': [row['id'] for row in rows]}

    @staticmethod
    def _triage_view(record):
        return {key: record.get(key) for key in (
            'kind', 'personal_project_id', 'topic', 'source', 'labeled_at', 'formed_project_id')}
