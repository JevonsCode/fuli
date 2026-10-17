"""Transactional conversation journal in the private graph; no LLM/embeddings."""
import base64
import gzip
import hashlib
import json
from fastapi import HTTPException
from .agent_conversation_models import ConversationPolicy
from .conversation_context import (
    add_task_result, fold_messages, message_bytes, pack_context, render_digest,
)
from .project_agent_access import authorize_project_agent
from .provider_values import now_utc, stable_uuid
from .store_conversation_triage import StoreConversationTriage
from .store_transactions import query_store_transaction

CONTEXT_PAGE_EVENTS = 50
CONTEXT_SCAN_EVENTS = 1000
CONTEXT_DECODE_BYTES = 512 * 1024


def encode_event(event):
    raw = json.dumps(event.model_dump(), ensure_ascii=False, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest(), base64.b64encode(gzip.compress(raw, mtime=0)).decode()


def decode_event(row):
    return {**json.loads(gzip.decompress(base64.b64decode(row['payload']))), 'sequence': row['sequence']}


class StoreAgentConversations:
    async def _conversation_scope(self, actor, request, *, write=False):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer' if write else 'reader')
        agent = await authorize_project_agent(self, actor, space, request.personal_project_id,
            request.agent_id, require_active=write, require_memory=True, allow_global=True)
        if request.source_application is not None and request.source_application not in json.loads(agent['profile_json']).get('allowed_clients', []):
            raise HTTPException(403, 'Agent is not allowed in this client')
        if request.personal_project_id is None:
            return stable_uuid('global-conversation-scope', space['id'], agent['agent_id'])
        return stable_uuid('conversation-scope', space['id'], request.personal_project_id, agent['agent_id'])

    async def _conversation_task(self, actor, request):
        await self.runtime.driver.execute_query(
            'MATCH (s:FuliTaskContextSession {id: $id}) SET s.conversation_serial=coalesce(s.conversation_serial,0)+1',
            id=self._task_session_id(request.personal_space_id, request.source_application, request.session_id))
        task = await self.get_task_context(actor, request.personal_space_id,
            request.task_context_token, request.source_application)
        if (task['session_id'], task['personal_project_id'], task['project_agent_id']) != (
            request.session_id, request.personal_project_id, request.agent_id):
            raise HTTPException(409, 'Conversation does not match the current task Agent and session')

    async def _conversation_policy(self, scope):
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (p:FuliConversationPolicy {id: $scope}) RETURN p.policy AS policy', scope=scope)
        return ConversationPolicy.model_validate_json(rows[0]['policy']) if rows else ConversationPolicy()

    async def write_conversation_policy(self, actor, request):
        scope = await self._conversation_scope(actor, request, write=True)
        await self.runtime.driver.execute_query(
            'MERGE (p:FuliConversationPolicy {id: $scope}) SET p.policy=$policy',
            scope=scope, policy=request.policy.model_dump_json())
        return request.policy.model_dump()

    async def query_conversations(self, actor, request):
        scope = await self._conversation_scope(actor, request)
        policy = await self._conversation_policy(scope)
        if request.mode == 'policy':
            return policy.model_dump()
        if request.mode == 'session':
            rows, _, _ = await self.runtime.driver.execute_query(
                'OPTIONAL MATCH (b:FuliConversationBinding {id: $id}) '
                'OPTIONAL MATCH (s:FuliTranscriptCursor {id: $stream}) '
                'RETURN b.conversation_id AS conversation_id, coalesce(s.cursor,0) AS cursor, '
                'coalesce(s.initialized, s.cursor > 0, false) AS initialized',
                stream=stable_uuid(request.personal_space_id, request.source_application, request.session_id or ''),
                id=stable_uuid(scope, request.source_application, request.session_id or ''))
            return dict(rows[0]) if rows else {'conversation_id': None, 'cursor': 0, 'initialized': False}
        if request.mode == 'list':
            # Jefa's triage label travels with each conversation so a list can
            # show what is still unclaimed without a second read per row.
            rows, _, _ = await self.runtime.driver.execute_query(
                'MATCH (c:FuliConversation {scope: $scope}) '
                'OPTIONAL MATCH (t:FuliConversationTriage {id: c.id}) '
                'RETURN c, t ORDER BY c.last_activity DESC, c.id LIMIT $limit',
                scope=scope, limit=request.limit)
            return {'conversations': [{**self._conversation_view(dict(r['c']), policy),
                'triage': StoreConversationTriage._triage_view(dict(r.get('t'))) if r.get('t') else None} for r in rows]}
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {scope: $scope, id: $id}) RETURN c', scope=scope, id=request.conversation_id)
        if not rows:
            raise HTTPException(404, 'Conversation not found in this Agent and project')
        record = dict(rows[0]['c'])
        view = self._conversation_view(record, policy)
        if request.mode == 'context':
            decoded, omitted, scan_truncated = await self._context_events(record, request.after)
            checkpoint = {'status': record.get('status') or 'reported', 'summary': record.get('summary')}
            return {**view, 'context': pack_context('', decoded, policy.context_budget, checkpoint,
                conversation_id=record['id'], revision=record['revision'],
                omitted_sequence=omitted, scan_truncated=scan_truncated)}
        events, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id})-[:HAS_EVENT]->(e:FuliConversationEvent) '
            'WHERE e.sequence > $after AND e.sequence <= $revision '
            'RETURN e.payload AS payload, e.sequence AS sequence '
            'ORDER BY e.sequence ASC LIMIT $limit', id=record['id'], after=request.after,
            revision=record['revision'], limit=request.limit)
        decoded = []
        total = 0
        for event in events:
            value = decode_event(event)
            total += len(json.dumps(value, ensure_ascii=False).encode())
            if total > 512 * 1024 and decoded:
                break
            decoded.append(value)
        cursor = decoded[-1]['sequence'] if decoded else request.after
        page = {**view, 'events': decoded, 'next_cursor': cursor, 'has_more': cursor < record['revision']}
        if request.after == 0:
            # The first history page shows what compaction extracted and where it came from.
            page['digest'] = json.loads(record['digest']) if record.get('digest') else None
        return page

    async def _context_events(self, record, after):
        """Read a fixed revision backwards; folding never deletes raw recovery.

        Stop at the third visible user message, not the third journal event.
        Bounded scans also cover long tool/checkpoint-only stretches.
        """
        before, scanned, total, users, decoded = record['revision'] + 1, 0, 0, 0, []
        while scanned < CONTEXT_SCAN_EVENTS:
            rows, _, _ = await self.runtime.driver.execute_query(
                'MATCH (c:FuliConversation {id: $id})-[:HAS_EVENT]->(e:FuliConversationEvent) '
                'WHERE e.sequence > $after AND e.sequence <= $revision AND e.sequence < $before '
                'RETURN e.payload AS payload, e.sequence AS sequence '
                'ORDER BY e.sequence DESC LIMIT $limit', id=record['id'], after=after,
                revision=record['revision'], before=before,
                limit=min(CONTEXT_PAGE_EVENTS, CONTEXT_SCAN_EVENTS - scanned))
            if not rows:
                return list(reversed(decoded)), None, False
            for row in rows:
                value = decode_event(row)
                total += len(json.dumps(value, ensure_ascii=False).encode())
                if total > CONTEXT_DECODE_BYTES:
                    return list(reversed(decoded)), row['sequence'], True
                scanned += 1
                before = row['sequence']
                if value['role'] not in ('user', 'assistant') or value.get('kind', 'message') != 'message':
                    continue
                decoded.append(value)
                users += value['role'] == 'user'
                if users == 3:
                    omitted = before - 1 if before > after + 1 else None
                    return list(reversed(decoded)), omitted, False
            if before <= after + 1:
                return list(reversed(decoded)), None, False
        return list(reversed(decoded)), before - 1, True

    def _conversation_view(self, record, policy):
        return {key: record.get(key) for key in ('id', 'summary', 'status', 'revision', 'last_activity')} | {
            'compacted_through': record.get('compacted_through') or 0,
            'unfolded_bytes': record.get('unfolded_bytes') or 0,
            'policy': policy.model_dump(), 'raw_retained': True}

    @staticmethod
    def _digest_text(record, budget=None):
        """Historical recovery text; the latest checkpoint is returned separately."""
        if not record.get('digest'):
            return ''
        digest = json.loads(record['digest'])
        tasks = digest.get('tasks', [])
        if tasks and tasks[-1]['summary'] == record.get('summary'):
            digest = {**digest, 'tasks': tasks[:-1]}
        return render_digest(digest, budget)

    async def _compact_conversation(self, conversation_id, policy):
        """Fold older messages into the digest, keeping recent ones verbatim."""
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id}) RETURN c', id=conversation_id)
        record = dict(rows[0]['c'])
        threshold = policy.compact_after_kb * 1024
        if (record.get('unfolded_bytes') or 0) <= threshold:
            return
        events, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id})-[:HAS_EVENT]->(e:FuliConversationEvent) '
            'WHERE e.sequence > $after RETURN e.payload AS payload, e.sequence AS sequence '
            'ORDER BY e.sequence', id=conversation_id, after=record.get('compacted_through') or 0)
        decoded = [decode_event(event) for event in events]
        if not decoded:
            return
        # The newest event always stays verbatim, then as much as fits a quarter.
        keep_bytes, cut = threshold // 4, len(decoded) - 1
        kept = message_bytes(decoded[cut])
        while cut and kept + message_bytes(decoded[cut - 1]) <= keep_bytes:
            cut -= 1
            kept += message_bytes(decoded[cut])
        if not cut:
            return
        digest = json.loads(record['digest']) if record.get('digest') else {}
        await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id}) '
            'SET c.digest=$digest, c.compacted_through=$through, c.unfolded_bytes=$kept',
            id=conversation_id, digest=json.dumps(fold_messages(digest, decoded[:cut]), ensure_ascii=False),
            through=decoded[cut - 1]['sequence'], kept=kept)

    async def append_conversation(self, actor, request):
        if request.initialize_cursor:
            raise HTTPException(422, 'Initialize transcripts only at a verified task boundary')
        async with query_store_transaction(self) as store:
            scope = await store._conversation_scope(actor, request, write=True)
            await store._conversation_task(actor, request)
            policy = await store._conversation_policy(scope)
            if not policy.enabled:
                return {'status': 'capture_disabled'}
            stream = stable_uuid(request.personal_space_id, request.source_application, request.session_id)
            streams, _, _ = await store.runtime.driver.execute_query(
                'MERGE (s:FuliTranscriptCursor {id: $id}) ON CREATE SET s.cursor=0, s.owner_scope=$scope '
                'SET s.serial=coalesce(s.serial,0)+1 RETURN s.cursor AS cursor, s.owner_scope AS owner_scope, '
                'coalesce(s.initialized, s.cursor > 0, false) AS initialized', id=stream, scope=scope)
            binding = stable_uuid(scope, request.source_application, request.session_id)
            rows, _, _ = await store.runtime.driver.execute_query(
                'MERGE (b:FuliConversationBinding {id: $id}) '
                'ON CREATE SET b.conversation_id=$conversation_id, b.cursor=0 '
                'SET b.serial=coalesce(b.serial,0)+1 RETURN b.conversation_id AS id, b.cursor AS cursor',
                id=binding, conversation_id=stable_uuid('conversation', binding))
            conversation_id = rows[0]['id']
            cursor = streams[0]['cursor']
            if request.expected_cursor is not None and not streams[0]['initialized']:
                raise HTTPException(409, 'Transcript must start at a verified task boundary')
            if request.expected_cursor is not None and streams[0]['owner_scope'] not in (None, scope):
                raise HTTPException(409, 'Transcript scope changed without a verified prompt boundary; do not import the old tail')
            if request.expected_cursor is not None and cursor != request.expected_cursor:
                raise HTTPException(409, 'Transcript cursor changed; reload before retrying')
            now = now_utc().isoformat()
            await store.runtime.driver.execute_query(
                'MERGE (c:FuliConversation {id: $id}) ON CREATE SET c.scope=$scope, c.revision=0, '
                "c.last_activity=$now, c.summary='', c.status='reported' "
                'SET c.serial=coalesce(c.serial,0)+1', id=conversation_id, scope=scope, now=now)
            new_summary = False
            unfolded = 0
            for event in request.events:
                digest, payload = encode_event(event)
                event_id = stable_uuid(conversation_id, request.source_application, request.session_id, event.event_id)
                existing, _, _ = await store.runtime.driver.execute_query(
                    'MATCH (e:FuliConversationEvent {id: $id}) RETURN e.digest AS digest', id=event_id)
                if existing:
                    if existing[0]['digest'] != digest:
                        raise HTTPException(409, 'Conversation event ID has different content')
                    continue
                if event.kind == 'checkpoint':
                    new_summary = True
                unfolded += message_bytes(event.model_dump())
                await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) SET c.revision=c.revision+1, c.last_activity=$now '
                    'CREATE (e:FuliConversationEvent {id: $event_id, digest: $digest, payload: $payload, '
                    'sequence: c.revision, source_application: $source, task_context_token: $task}) '
                    'CREATE (c)-[:HAS_EVENT]->(e)', id=conversation_id, event_id=event_id,
                    digest=digest, payload=payload, now=now, source=request.source_application,
                    task=request.task_context_token)
            if unfolded:
                await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) '
                    'SET c.unfolded_bytes=coalesce(c.unfolded_bytes,0)+$bytes',
                    id=conversation_id, bytes=unfolded)
            if request.summary is not None and new_summary:
                rows, _, _ = await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) RETURN c.digest AS digest', id=conversation_id)
                digest = json.loads(rows[0]['digest']) if rows[0]['digest'] else {}
                digest = add_task_result(digest, now, request.status or 'reported', request.summary)
                await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) SET c.summary=$summary, c.status=$status, c.digest=$digest',
                    id=conversation_id, summary=request.summary, status=request.status or 'reported',
                    digest=json.dumps(digest, ensure_ascii=False))
            await store._compact_conversation(conversation_id, policy)
            if request.cursor is not None:
                await store.runtime.driver.execute_query(
                    'MATCH (s:FuliTranscriptCursor {id: $id}) SET s.cursor=$cursor, s.owner_scope=$scope', id=stream, cursor=request.cursor, scope=scope)
            rows, _, _ = await store.runtime.driver.execute_query(
                'MATCH (c:FuliConversation {id: $id}) RETURN c.revision AS revision', id=conversation_id)
            return {'status': 'saved', 'conversation_id': conversation_id, 'revision': rows[0]['revision']}

    async def resume_conversation(self, actor, request):
        async with query_store_transaction(self) as store:
            scope = await store._conversation_scope(actor, request, write=True)
            await store._conversation_task(actor, request)
            rows, _, _ = await store.runtime.driver.execute_query(
                'MATCH (c:FuliConversation {id: $id, scope: $scope}) RETURN c.id AS id',
                id=request.conversation_id, scope=scope)
            if not rows:
                raise HTTPException(404, 'Conversation not found in this Agent and project')
            await store.runtime.driver.execute_query(
                'MERGE (b:FuliConversationBinding {id: $id}) ON CREATE SET b.cursor=0 '
                'SET b.conversation_id=$conversation_id', id=stable_uuid(scope, request.source_application, request.session_id),
                conversation_id=request.conversation_id)
            return {'status': 'resumed', 'conversation_id': request.conversation_id}

    async def claim_conversation_boundary(self, actor, request):
        if request.events or request.cursor is None or (not request.initialize_cursor and request.cursor != request.expected_cursor):
            raise HTTPException(422, 'A scope boundary cannot import events or skip bytes')
        async with query_store_transaction(self) as store:
            scope = await store._conversation_scope(actor, request, write=True)
            await store._conversation_task(actor, request)
            stream = stable_uuid(request.personal_space_id, request.source_application, request.session_id)
            if request.initialize_cursor:
                # First hook sync has no journal entry yet. Create only after authorization;
                # a failed CAS rolls this back in the same transaction.
                await store.runtime.driver.execute_query(
                    'MERGE (s:FuliTranscriptCursor {id:$id}) '
                    'ON CREATE SET s.cursor=0, s.initialized=false', id=stream)
            rows, _, _ = await store.runtime.driver.execute_query(
                'MATCH (s:FuliTranscriptCursor {id:$id}) SET s.serial=coalesce(s.serial,0)+1 '
                'WITH s WHERE s.cursor=$expected AND '
                '($initialize=false OR (s.cursor=0 AND coalesce(s.initialized,false)=false)) '
                'SET s.owner_scope=$scope, s.cursor=$cursor, s.initialized=true RETURN s.cursor AS cursor',
                id=stream,
                cursor=request.cursor, expected=request.expected_cursor, initialize=request.initialize_cursor, scope=scope)
            if not rows:
                raise HTTPException(409, 'Transcript cursor changed before scope boundary')
            return {'status': 'bound', 'cursor': request.cursor}
