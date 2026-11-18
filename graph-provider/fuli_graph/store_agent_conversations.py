"""Transactional conversation journal in the private graph; no LLM/embeddings."""
import base64
import gzip
import hashlib
import json
from datetime import timedelta
from fastapi import HTTPException
from .agent_conversation_models import ConversationPolicy, ConversationWrite
from .conversation_context import (
    COMPACTION_KIND, DIGEST_VERSION, add_delivery_proofs, add_task_result, fold_messages, message_bytes, note_compaction,
    pack_context, refold_digest,
)
from .project_agent_access import authorize_project_agent
from .conversation_scope import conversation_binding_id, conversation_scope_id, started_conversation_id
from .provider_values import now_utc, stable_uuid
from .store_conversation_triage import ASSISTANT_AGENT_ID, StoreConversationTriage, topic_key
from .store_transactions import query_store_transaction
from .store_transcript_recovery import recover_fallback_boundary
from .knowledge_versions import lock_knowledge
from .knowledge_source_fence import require_source_available
from .client_coverage import covers_client

CONTEXT_PAGE_EVENTS = 50
CONTEXT_SCAN_EVENTS = 1000
CONTEXT_DECODE_BYTES = 512 * 1024
# A conversation list names each conversation's latest host sessions.
SESSIONS_PER_CONVERSATION = 5
# A task entry names the Agent's other sessions active in the last hours.
SESSIONS_ELSEWHERE = 3
ELSEWHERE_WINDOW = timedelta(hours=6)


def _iso(value):
    return value.iso_format() if hasattr(value, 'iso_format') else (value.isoformat() if value else None)


def encode_event(event):
    raw = json.dumps(event.model_dump(), ensure_ascii=False, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest(), base64.b64encode(gzip.compress(raw, mtime=0)).decode()


def decode_event(row):
    return {**json.loads(gzip.decompress(base64.b64decode(row['payload']))), 'sequence': row['sequence']}


class StoreAgentConversations:
    async def _conversation_scope(self, actor, request, *, write=False):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer' if write else 'reader')
        # The fixed assistant keeps no reviewed memory, but its global conversation
        # journal is what holds unclaimed conversations until they are triaged.
        journal_only = request.personal_project_id is None and request.agent_id == ASSISTANT_AGENT_ID
        agent = await authorize_project_agent(self, actor, space, request.personal_project_id,
            request.agent_id, require_active=write, require_memory=not journal_only, allow_global=True)
        if request.source_application is not None and not covers_client(json.loads(agent['profile_json']).get('allowed_clients', []), request.source_application):
            raise HTTPException(403, 'Agent is not allowed in this client')
        return conversation_scope_id(space['id'], request.personal_project_id, agent['agent_id'])

    async def _conversation_task(self, actor, request):
        await self.runtime.driver.execute_query(
            'MATCH (s:FuliTaskContextSession {id: $id}) SET s.conversation_serial=coalesce(s.conversation_serial,0)+1',
            id=self._task_session_id(request.personal_space_id, request.source_application, request.session_id))
        task = await self.get_task_context(actor, request.personal_space_id,
            request.task_context_token, request.source_application)
        if (task['session_id'], task['personal_project_id'], task['project_agent_id']) != (
            request.session_id, request.personal_project_id, request.agent_id):
            raise HTTPException(409, 'Conversation does not match the current task Agent and session')
        return task

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
            return await self._session_binding(scope, request)
        if request.mode == 'list':
            return {'conversations': await self._latest_conversations(
                scope, policy, request.limit, topic_key(request.topic) if request.topic else None)}
        record = await self._scoped_conversation(scope, request.conversation_id)
        if request.mode == 'context':
            return await self._recovery_context(record, policy, request, after=request.after)
        view = self._conversation_view(record, policy)
        events, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id})-[:HAS_EVENT]->(e:FuliConversationEvent) '
            'WHERE e.sequence > $after AND e.sequence <= $revision '
            'RETURN e.payload AS payload, e.sequence AS sequence, '
            'e.source_application AS source_application, e.session_id AS session_id '
            'ORDER BY e.sequence ASC LIMIT $limit', id=record['id'], after=request.after,
            revision=record['revision'], limit=request.limit + 1)
        decoded = []
        total = 0
        for event in events[:request.limit]:
            # Each event names the client and native session that wrote it.
            value = {**decode_event(event), 'client': event.get('source_application'),
                     'session_id': event.get('session_id')}
            total += len(json.dumps(value, ensure_ascii=False).encode())
            if total > 512 * 1024 and decoded:
                break
            decoded.append(value)
        cursor = decoded[-1]['sequence'] if decoded else request.after
        sources = await self._event_sources(record['id'], decoded)
        # Deletion leaves gaps and advances revision without adding an event.
        # Only a retained event beyond this page proves there is another page.
        page = {**view, 'events': decoded, 'sources': sources, 'next_cursor': cursor,
                'has_more': len(events) > len(decoded)}
        if request.after == 0:
            # The first history page shows what compaction extracted and where it came from.
            page['digest'] = await self._current_digest(record)
        return page

    async def begin_conversation(self, actor, request):
        """A task entry's conversation in one request and one transaction (rec#11 D-53).

        The three steps a host used to send one by one, in the same order: the
        session's bound conversation; then its recovery window with this
        session's delivery proofs, or else the latest conversation of this
        Agent's scope; then the empty append that opens this task's
        conversation. The reads keep the query route's checks and the append
        all of append_conversation's; a refused append rolls the request back,
        so no read leaves the Provider without the write."""
        async with query_store_transaction(self) as store:
            scope = await store._conversation_scope(actor, request)
            policy = await store._conversation_policy(scope)
            previous_id = (await store._session_binding(scope, request))['conversation_id']
            previous = await store._recovery_context(await store._scoped_conversation(scope, previous_id),
                policy, request) if previous_id else None
            recent = None if previous_id else next(iter(await store._latest_conversations(scope, policy, 1, sessions=False)), None)
            saved = await store.append_conversation(actor, ConversationWrite(**request.model_dump()))
            elsewhere = await store._sessions_elsewhere(scope, request, (now_utc() - ELSEWHERE_WINDOW).isoformat())
            return {**saved, 'recovered_from': previous_id, 'previous': previous, 'recent': recent,
                    'elsewhere': elsewhere}

    async def _session_binding(self, scope, request):
        rows, _, _ = await self.runtime.driver.execute_query(
            'OPTIONAL MATCH (b:FuliConversationBinding {id: $id}) '
            'OPTIONAL MATCH (s:FuliTranscriptCursor {id: $stream}) '
            'RETURN b.conversation_id AS conversation_id, coalesce(s.cursor,0) AS cursor, '
            'coalesce(s.initialized, s.cursor > 0, false) AS initialized',
            stream=stable_uuid(request.personal_space_id, request.source_application, request.session_id or ''),
            id=conversation_binding_id(scope, request.source_application, request.session_id or ''))
        return dict(rows[0]) if rows else {'conversation_id': None, 'cursor': 0, 'initialized': False}

    async def _latest_conversations(self, scope, policy, limit, topic=None, *, sessions=True):
        # Jefa's triage label travels with each conversation so a list can
        # show what is still unclaimed without a second read per row. topic
        # (a topic_key): only that topic's conversations still open, so the
        # next conversation about it finds the earlier ones; one formed into a
        # project belongs to that project and is no longer listed here.
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {scope: $scope}) '
            'OPTIONAL MATCH (t:FuliConversationTriage {id: c.id}) '
            'WITH c, t WHERE $topic IS NULL '
            "OR (t.kind = 'topic' AND t.topic_key = $topic AND t.formed_project_id IS NULL) "
            'RETURN c, t ORDER BY c.last_activity DESC, c.id LIMIT $limit',
            scope=scope, limit=limit, topic=topic)
        # A list names where each conversation was written from; a new session's
        # pointer (begin_conversation) carries only the latest conversation's title.
        found = await self._conversation_sessions([r['c']['id'] for r in rows]) if sessions else {}
        return [{**self._conversation_view(dict(r['c']), policy),
            **({'sessions': found.get(r['c']['id'], [])} if sessions else {}),
            'triage': StoreConversationTriage._triage_view(dict(r.get('t'))) if r.get('t') else None} for r in rows]

    async def _scoped_conversation(self, scope, conversation_id):
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {scope: $scope, id: $id}) RETURN c', scope=scope, id=conversation_id)
        if not rows:
            raise HTTPException(404, 'Conversation not found in this Agent and project')
        return dict(rows[0]['c'])

    async def _recovery_context(self, record, policy, request, *, after=0):
        decoded, omitted, scan_truncated = await self._context_events(record, after)
        checkpoint = {'status': record.get('status') or 'reported', 'summary': record.get('summary')}
        context = pack_context('', decoded, policy.context_budget, checkpoint,
            conversation_id=record['id'], revision=record['revision'],
            omitted_sequence=omitted, scan_truncated=scan_truncated,
            compaction=await self._latest_compaction(record))
        # A session's task entry asks with its own ID; the host strips these
        # proofs once it knows what that session has already seen.
        if request.session_id is not None and request.source_application is not None:
            add_delivery_proofs(context, decoded, request.source_application, request.session_id)
        return {**self._conversation_view(record, policy), 'context': context}

    async def _latest_compaction(self, record):
        """The newest client compaction summary within this revision, or None."""
        pointer = json.loads(record['digest']).get('compaction') if record.get('digest') else None
        if not pointer or pointer['sequence'] > record['revision']:
            return None
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id})-[:HAS_EVENT]->(e:FuliConversationEvent {sequence: $sequence}) '
            'RETURN e.payload AS payload, e.sequence AS sequence', id=record['id'], sequence=pointer['sequence'])
        return decode_event(rows[0]) if rows else None

    async def _current_digest(self, record):
        """The stored digest, rebuilt once from raw events when older folding rules made it."""
        if not record.get('digest'):
            return None
        digest = json.loads(record['digest'])
        through = record.get('compacted_through') or 0
        if digest.get('version') == DIGEST_VERSION or not through:
            return digest
        events, _, _ = await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id})-[:HAS_EVENT]->(e:FuliConversationEvent) '
            'WHERE e.sequence > $after AND e.sequence <= $revision '
            'RETURN e.payload AS payload, e.sequence AS sequence ORDER BY e.sequence ASC',
            id=record['id'], after=0, revision=through)
        rebuilt = refold_digest(digest, [decode_event(event) for event in events])
        # Only replace the digest that was read; a concurrent compaction wins.
        await self.runtime.driver.execute_query(
            'MATCH (c:FuliConversation {id: $id}) WHERE c.digest = $old SET c.digest = $digest',
            id=record['id'], old=record['digest'], digest=json.dumps(rebuilt, ensure_ascii=False))
        return rebuilt

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
                'RETURN e.payload AS payload, e.sequence AS sequence, '
                'e.session_id AS session_id, e.source_application AS source_application '
                'ORDER BY e.sequence DESC LIMIT $limit', id=record['id'], after=after,
                revision=record['revision'], before=before,
                limit=min(CONTEXT_PAGE_EVENTS, CONTEXT_SCAN_EVENTS - scanned))
            if not rows:
                return list(reversed(decoded)), None, False
            for row in rows:
                value = decode_event(row)
                total += len(json.dumps(value, ensure_ascii=False).encode())
                value.update(session_id=row.get('session_id'), source_application=row.get('source_application'))
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
        return {key: record.get(key) for key in ('id', 'summary', 'title', 'status', 'revision', 'last_activity')} | {
            'compacted_through': record.get('compacted_through') or 0,
            'unfolded_bytes': record.get('unfolded_bytes') or 0,
            # Which client and native session wrote the opening words the title holds.
            'title_source': ({'client': record.get('title_source_application'), 'session_id': record.get('title_session_id')}
                             if record.get('title_session_id') else None),
            'policy': policy.model_dump(), 'raw_retained': True}

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
        if request.initialize_cursor or request.fallback_recovery:
            raise HTTPException(422, 'Initialize transcripts only at a verified task boundary')
        async with query_store_transaction(self) as store:
            space = await store.authorize(actor, request.personal_space_id, 'maintainer')
            await lock_knowledge(store, space)
            await require_source_available(store, space, source_application=request.source_application,
                session_id=request.session_id, task_token=request.task_context_token)
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
            binding = conversation_binding_id(scope, request.source_application, request.session_id)
            rows, _, _ = await store.runtime.driver.execute_query(
                'MERGE (b:FuliConversationBinding {id: $id}) '
                'ON CREATE SET b.conversation_id=$conversation_id, b.cursor=0 '
                'SET b.serial=coalesce(b.serial,0)+1 RETURN b.conversation_id AS id, b.cursor AS cursor',
                id=binding, conversation_id=started_conversation_id(binding))
            conversation_id = rows[0]['id']
            cursor = streams[0]['cursor']
            if request.expected_cursor is not None and not streams[0]['initialized']:
                raise HTTPException(409, 'Transcript must start at a verified task boundary')
            if request.expected_cursor is not None and streams[0]['owner_scope'] not in (None, scope):
                raise HTTPException(409, 'Transcript scope changed without a verified prompt boundary; do not import the old tail')
            if request.expected_cursor is not None and cursor != request.expected_cursor:
                raise HTTPException(409, 'Transcript cursor changed; reload before retrying')
            created_at = now_utc()
            now = created_at.isoformat()
            provenance = request.provenance
            # A conversation is titled once, when it opens: a later task's words never name an earlier one.
            await store.runtime.driver.execute_query(
                'MERGE (c:FuliConversation {id: $id}) ON CREATE SET c.scope=$scope, c.revision=0, '
                "c.last_activity=$now, c.summary='', c.status='reported', c.title=$title, "
                'c.title_source_application=CASE WHEN $title IS NULL THEN null ELSE $source END, '
                'c.title_session_id=CASE WHEN $title IS NULL THEN null ELSE $session END '
                'SET c.serial=coalesce(c.serial,0)+1',
                id=conversation_id, scope=scope, now=now, title=provenance.title if provenance else None,
                source=request.source_application, session=request.session_id)
            await store._note_session(scope, conversation_id, request, now)
            new_summary = False
            compaction = None
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
                created, _, _ = await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) SET c.revision=c.revision+1, c.last_activity=$now '
                    'CREATE (e:FuliConversationEvent {id: $event_id, digest: $digest, payload: $payload, '
                    'sequence: c.revision, source_application: $source, task_context_token: $task, '
                    'session_id: $session, created_at: $created_at}) '
                    'CREATE (c)-[:HAS_EVENT]->(e) RETURN e.sequence AS sequence', id=conversation_id, event_id=event_id,
                    digest=digest, payload=payload, now=now, source=request.source_application,
                    task=request.task_context_token, session=request.session_id, created_at=created_at)
                if event.kind == COMPACTION_KIND:
                    compaction = (created[0]['sequence'], len(event.content.encode()))
            if unfolded:
                await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) '
                    'SET c.unfolded_bytes=coalesce(c.unfolded_bytes,0)+$bytes',
                    id=conversation_id, bytes=unfolded)
            if compaction:
                rows, _, _ = await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) RETURN c.digest AS digest', id=conversation_id)
                digest = json.loads(rows[0]['digest']) if rows[0]['digest'] else {}
                await store.runtime.driver.execute_query(
                    'MATCH (c:FuliConversation {id: $id}) SET c.digest=$digest', id=conversation_id,
                    digest=json.dumps(note_compaction(digest, *compaction), ensure_ascii=False))
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
                'SET b.conversation_id=$conversation_id',
                id=conversation_binding_id(scope, request.source_application, request.session_id),
                conversation_id=request.conversation_id)
            # The resumed conversation gains this session; the one it left keeps its record.
            await store._note_session(scope, request.conversation_id, request, now_utc().isoformat())
            return {'status': 'resumed', 'conversation_id': request.conversation_id}

    async def _note_session(self, scope, conversation_id, request, now):
        """Where this host session worked on this conversation: its client and
        session, when it was first and last seen here, and the folder and model
        its entry reported (kept until a later entry reports another). One
        record per conversation and session, so a resume elsewhere never
        rewrites where an earlier conversation was written from."""
        provenance = getattr(request, 'provenance', None)
        # A session that joins a conversation by resume reports no folder or model
        # itself: it brings what its latest record elsewhere in this scope knows.
        await self.runtime.driver.execute_query(
            'OPTIONAL MATCH (o:FuliConversationSession {scope: $scope}) '
            'WHERE o.source_application = $source AND o.session_id = $session AND o.id <> $id '
            'WITH o ORDER BY o.last_seen DESC LIMIT 1 '
            'MERGE (s:FuliConversationSession {id: $id}) '
            'ON CREATE SET s.conversation_id=$conversation_id, s.scope=$scope, s.source_application=$source, '
            's.session_id=$session, s.first_seen=$now '
            'SET s.last_seen=$now, s.working_directory=coalesce($folder, s.working_directory, o.working_directory), '
            's.model=coalesce($model, s.model, o.model), s.branch=coalesce($branch, s.branch, o.branch)',
            id=stable_uuid('conversation-session', conversation_id, request.source_application, request.session_id),
            conversation_id=conversation_id, scope=scope, source=request.source_application, session=request.session_id,
            now=now, folder=provenance.working_directory if provenance else None,
            model=provenance.model if provenance else None, branch=provenance.branch if provenance else None)

    async def _event_sources(self, conversation_id, events):
        """Where the sessions on a history page worked (model, folder, branch),
        once per session, from their records; a session written before graph
        22 is named by client and session only."""
        pairs = sorted({(e['client'], e['session_id']) for e in events if e.get('client') and e.get('session_id')})
        if not pairs:
            return []
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (s:FuliConversationSession {conversation_id: $id}) '
            'RETURN s.source_application AS client, s.session_id AS session_id, s.model AS model, '
            's.working_directory AS working_directory, s.branch AS branch', id=conversation_id)
        known = {(row['client'], row['session_id']): row for row in rows}
        return [{key: value for key, value in dict(known.get(pair, {'client': pair[0], 'session_id': pair[1]})).items()
                 if value is not None} for pair in pairs]

    async def _conversation_sessions(self, conversation_ids, limit=SESSIONS_PER_CONVERSATION):
        """The host sessions each conversation was written from, newest first.
        A conversation written before graph 22 has no such records: its
        journal events name the client and session, with their times."""
        if not conversation_ids:
            return {}
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (s:FuliConversationSession) WHERE s.conversation_id IN $ids '
            'RETURN s.conversation_id AS conversation_id, s.source_application AS client, s.session_id AS session_id, '
            's.model AS model, s.working_directory AS working_directory, s.branch AS branch, s.first_seen AS first_seen, '
            's.last_seen AS last_seen ORDER BY s.last_seen DESC', ids=list(conversation_ids))
        sessions = {}
        for row in rows:
            sessions.setdefault(row['conversation_id'], []).append(
                {key: value for key, value in dict(row).items() if key != 'conversation_id' and value is not None})
        older = [cid for cid in conversation_ids if cid not in sessions]
        if older:
            rows, _, _ = await self.runtime.driver.execute_query(
                'MATCH (c:FuliConversation)-[:HAS_EVENT]->(e:FuliConversationEvent) WHERE c.id IN $ids '
                'WITH c.id AS conversation_id, e.source_application AS client, e.session_id AS session_id, '
                'min(e.created_at) AS first_seen, max(e.created_at) AS last_seen '
                'RETURN conversation_id, client, session_id, first_seen, last_seen ORDER BY last_seen DESC', ids=older)
            for row in rows:
                sessions.setdefault(row['conversation_id'], []).append({
                    'client': row['client'], 'session_id': row['session_id'],
                    'first_seen': _iso(row['first_seen']), 'last_seen': _iso(row['last_seen'])})
        return {cid: found[:limit] for cid, found in sessions.items()}

    async def _sessions_elsewhere(self, scope, request, since):
        """Other host sessions of this Agent in this scope seen since `since`,
        newest first and one row each, with the conversation it last worked on
        and that conversation's summary or title: where else the same Agent
        works right now. Read through the (scope, last_seen) index."""
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (s:FuliConversationSession {scope: $scope}) '
            'WHERE s.last_seen >= $since AND NOT (s.source_application = $source AND s.session_id = $session) '
            'WITH s ORDER BY s.last_seen DESC LIMIT $scan '
            'MATCH (c:FuliConversation {id: s.conversation_id}) '
            'RETURN c.id AS conversation_id, s.source_application AS client, s.session_id AS session_id, '
            's.model AS model, s.working_directory AS working_directory, s.branch AS branch, s.last_seen AS last_seen, '
            "CASE WHEN c.summary <> '' THEN c.summary ELSE c.title END AS title "
            'ORDER BY s.last_seen DESC',
            scope=scope, since=since, source=request.source_application, session=request.session_id,
            scan=SESSIONS_ELSEWHERE * 4)
        seen, found = set(), []
        for row in rows:
            key = (row['client'], row['session_id'])
            if key in seen:
                continue
            seen.add(key)
            found.append({key: value for key, value in dict(row).items() if value is not None})
        return found[:SESSIONS_ELSEWHERE]

    async def claim_conversation_boundary(self, actor, request):
        if request.fallback_recovery:
            return await recover_fallback_boundary(self, actor, request)
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
