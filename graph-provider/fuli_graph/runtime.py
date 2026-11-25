import asyncio
import hashlib
import logging
import math
import os
import re
import unicodedata
from collections.abc import Iterable
from contextlib import AsyncExitStack, asynccontextmanager, nullcontext
from typing import Any

os.environ.setdefault('GRAPHITI_TELEMETRY_ENABLED', 'false')

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.driver.neo4j_driver import Neo4jDriver, _Neo4jTransaction
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.llm_client.client import LLMClient
from graphiti_core.llm_client.config import LLMConfig, ModelSize
from graphiti_core.prompts.models import Message
from fastapi import HTTPException
from neo4j import READ_ACCESS, WRITE_ACCESS, RoutingControl
from neo4j.exceptions import ClientError, Neo4jError, ServiceUnavailable, SessionExpired
from pydantic import BaseModel

from .config import Settings
from .graph_format import UNCHECKED, GraphFormatUnavailable, prepare_graph_format, writer_fence

_ACCESS_MODE_ERROR = 'Neo.ClientError.Statement.AccessMode'

# The driver logs every DBMS notification (an unknown label or property key in
# Graphiti's queries, which a sparse graph meets on almost every search) as a
# warning with the whole query, which filled provider.log to gigabytes. Driver
# errors still raise and are logged by their callers.
logging.getLogger('neo4j.notifications').setLevel(logging.ERROR)

logger = logging.getLogger(__name__)


class AgentStructuredLLM(LLMClient):
    """Guardrail that prevents the provider from sending knowledge to another LLM."""

    def __init__(self):
        super().__init__(
            LLMConfig(
                api_key='disabled',
                model='agent-structured-input',
                small_model='agent-structured-input',
                max_tokens=1,
            )
        )

    async def _generate_response(
        self,
        messages: list[Message],
        response_model: type[BaseModel] | None = None,
        max_tokens: int = 1,
        model_size: ModelSize = ModelSize.medium,
    ) -> dict[str, Any]:
        del messages, response_model, max_tokens, model_size
        raise RuntimeError(
            'This Fuli provider accepts agent-structured graph input and never invokes a second LLM'
        )


class LocalHashEmbedder(EmbedderClient):
    """Small deterministic multilingual embedder with no model or network dependency."""

    # Names the feature hashing; changing it changes every similarity score.
    version = 'fuli-embed-v1'

    def __init__(self, dimensions: int):
        if dimensions < 64:
            raise ValueError('Local hash embeddings require at least 64 dimensions')
        self.dimensions = dimensions

    async def create(
        self,
        input_data: str | list[str] | Iterable[int] | Iterable[Iterable[int]],
    ) -> list[float]:
        text = input_data if isinstance(input_data, str) else ' '.join(map(str, input_data))
        return self._embed(text)

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return [self._embed(value) for value in input_data_list]

    def _embed(self, value: str) -> list[float]:
        normalized = unicodedata.normalize('NFKC', value).casefold()
        compact = ''.join(character for character in normalized if not character.isspace())
        features = re.findall(r'[\w.-]+', normalized, flags=re.UNICODE)
        features.extend(compact[index : index + 2] for index in range(max(len(compact) - 1, 0)))
        features.extend(compact[index : index + 3] for index in range(max(len(compact) - 2, 0)))
        vector = [0.0] * self.dimensions
        for feature in features:
            if not feature:
                continue
            digest = hashlib.blake2b(
                feature.encode('utf-8'),
                digest_size=8,
                person=self.version.encode('ascii'),
            ).digest()
            bucket = int.from_bytes(digest[:4], 'big') % self.dimensions
            vector[bucket] += 1.0 if digest[4] & 1 else -1.0
        magnitude = math.sqrt(sum(value * value for value in vector))
        return vector if magnitude == 0 else [value / magnitude for value in vector]


class LocalLexicalReranker(CrossEncoderClient):
    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        query_terms = set(query.casefold().split())

        def score(passage: str) -> float:
            normalized = passage.casefold()
            if query.casefold() in normalized:
                return 1.0
            if not query_terms:
                return 0.0
            matches = sum(term in normalized for term in query_terms)
            return matches / len(query_terms)

        return sorted(
            [(passage, score(passage)) for passage in passages],
            key=lambda item: item[1],
            reverse=True,
        )


class ManagedNeo4jDriver(Neo4jDriver):
    """The provider's only graph connection, held to the graph's data format.

    The format registry (graph_format.py) declares and creates every index
    and constraint, Graphiti's included, so the dependency's own index build,
    scheduled eagerly whenever its driver is constructed inside a running
    event loop, never runs.

    Every query passes the format check first: until prepare_graph_format has
    decided, nothing runs; a read-only graph runs every query in Neo4j's read
    access mode, so the database itself refuses a write; a refused graph runs
    nothing. Only the maintenance handle, used by the format check itself,
    bypasses this.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.format = UNCHECKED
        # Set by GraphitiRuntime: keeps writes off read-only copies (replica_write_guard.py).
        self.replica_guard = None
        # Installed by the project-move coordinator when scoped write admission is active.
        self.write_admission = nullcontext

    def build_indices_and_constraints(self, delete_existing: bool = False):
        return _completed_index_build()

    def maintenance(self) -> '_MaintenanceDriver':
        return _MaintenanceDriver(self)

    def read_only(self) -> '_ReadOnlyDriver':
        """Reads for the format report, in Neo4j's read access mode whatever
        the format state: Neo4j itself refuses any write through it."""
        return _ReadOnlyDriver(self)

    def _access_mode(self) -> str:
        if self.format.access == 'none':
            raise self.format.refusal()
        return READ_ACCESS if self.format.access == 'read' else WRITE_ACCESS

    def _refused_write(self, error: ClientError) -> bool:
        return self.format.access == 'read' and error.code == _ACCESS_MODE_ERROR

    async def execute_query(self, cypher_query_, **kwargs):
        if self._access_mode() == READ_ACCESS:
            kwargs['routing_'] = RoutingControl.READ
            try:
                return await super().execute_query(cypher_query_, **kwargs)
            except ClientError as error:
                if self._refused_write(error):
                    raise self.format.refusal() from error
                raise
        if kwargs.get('routing_') in (RoutingControl.READ, 'r'):
            return await super().execute_query(cypher_query_, **kwargs)
        return await self._fenced_query(cypher_query_, kwargs)

    async def _fenced_query(self, query, kwargs):
        """A write as one transaction with the writer fence as its last
        statement, shaped like the driver's execute_query result (records,
        summary, keys); the session retries a transient error (a deadlock) as
        the driver's own call does. Deliberately not built on transaction(),
        which callers may wrap."""
        parameters = dict(kwargs.pop('params', None) or {})
        parameters.pop('database_', None)
        database = kwargs.get('database_') or self._database
        parameters.update({key: value for key, value in kwargs.items() if not key.endswith('_')})

        async def work(transaction):
            result = await transaction.run(query, parameters)
            eager = await result.to_eager_result()
            return eager, await self.before_commit(transaction)

        async with self.write_admission(), self.client.session(database=database, default_access_mode=WRITE_ACCESS) as session:
            result, ticket = await session.execute_write(work)
        await self.after_commit(ticket)
        return result

    def transaction(self):
        if self._access_mode() == WRITE_ACCESS:
            return self._fenced_transaction()
        return self._read_only_transaction()

    def read_transaction(self):
        """One transaction in Neo4j's read access mode whatever the format
        allows, so Neo4j itself refuses a write inside it (scope_export.py)."""
        self._access_mode()
        return self._read_only_transaction()

    @asynccontextmanager
    async def _fenced_transaction(self, *, copies_checked=True):
        """The dependency's own write transaction, the fence its last statement."""
        ticket = None
        async with self.write_admission(), Neo4jDriver.transaction(self) as transaction:
            yield transaction
            if copies_checked:
                ticket = await self.before_commit(transaction)
            else:
                await writer_fence(transaction)
        await self.after_commit(ticket)

    async def before_commit(self, transaction):
        """The last statements of every business write: no read-only copy
        changed (replica_write_guard.py), then the writer fence."""
        ticket = await self.replica_guard.check(transaction) if self.replica_guard is not None else None
        await writer_fence(transaction)
        return ticket

    async def after_commit(self, ticket):
        if ticket is not None:
            await self.replica_guard.observe_commit(ticket, self.read_transaction)

    @asynccontextmanager
    async def replica_import_transaction(self):
        """Write admission for imports, releases and authorized handover phases. The copies' digests
        are taken again once it committed; writes meanwhile compare with those."""
        guard = self.replica_guard
        async with guard.classifying_copies(), guard.held_for_import():
            async with self._fenced_transaction(copies_checked=False) as transaction:
                yield transaction
            await self.refresh_replica_guard()

    async def refresh_replica_guard(self) -> None:
        async with self.read_transaction() as transaction:
            await self.replica_guard.refresh(transaction)

    @asynccontextmanager
    async def _read_only_transaction(self):
        try:
            async with self.client.session(
                database=self._database, default_access_mode=READ_ACCESS
            ) as session:
                tx = await session.begin_transaction()
                try:
                    yield _Neo4jTransaction(tx)
                    await tx.commit()
                except BaseException:
                    await tx.rollback()
                    raise
        except ClientError as error:
            if self._refused_write(error):
                raise self.format.refusal() from error
            raise

    def session(self, database: str | None = None):
        mode = self._access_mode()
        session = self.client.session(database=database or self._database, default_access_mode=mode)
        return _FencedSession(session, self.before_commit, self.after_commit, self.write_admission) if mode == WRITE_ACCESS else session


class _FencedSession:
    """A write session whose transactions pass the writer fence first."""

    def __init__(self, session, before_commit, after_commit, write_admission):
        self._session = session
        self._admit = write_admission
        self._explicit = None
        self._before_commit = before_commit
        self._after_commit = after_commit

    async def __aenter__(self):
        await self._session.__aenter__()
        return self

    async def __aexit__(self, *exc):
        try:
            return await self._session.__aexit__(*exc)
        finally:
            await self._release_explicit()

    async def close(self):
        try:
            return await self._session.close()
        finally:
            await self._release_explicit()

    async def _release_explicit(self):
        if self._explicit:
            await self._explicit.aclose()
            self._explicit = None

    async def execute_write(self, work, *args, **kwargs):
        async def fenced(transaction, *work_args, **work_kwargs):
            result = await work(transaction, *work_args, **work_kwargs)
            return result, await self._before_commit(transaction)

        async with self._admit():
            result, ticket = await self._session.execute_write(fenced, *args, **kwargs)
        await self._after_commit(ticket)
        return result

    # Neo4j 5 also exposes this deprecated spelling.
    write_transaction = execute_write

    async def begin_transaction(self, *args, **kwargs):
        async with AsyncExitStack() as stack:
            await stack.enter_async_context(self._admit())
            transaction = await self._session.begin_transaction(*args, **kwargs)
            lifetime = stack.pop_all()
            self._explicit = lifetime
            return _FencedTransaction(transaction, self._before_commit, self._after_commit, lifetime)

    async def run(self, query, *args, **kwargs):
        # An auto-commit write (CALL … IN TRANSACTIONS, as Graphiti's delete by
        # group uses) cannot share a transaction with the fence, so it is not
        # run at all: a write must use execute_write or a transaction. No FULI
        # path writes this way.
        raise GraphFormatUnavailable(
            'data_format_unfenced_write',
            'An auto-commit write cannot pass the graph writer fence; use a write transaction.',
        )

    def __getattr__(self, name):
        return getattr(self._session, name)


class _FencedTransaction:
    """An explicit write transaction whose commit passes the fence first."""

    def __init__(self, transaction, before_commit, after_commit, lifetime):
        self._transaction = transaction
        self._before_commit = before_commit
        self._after_commit = after_commit
        self._lifetime = lifetime
        self._finished = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, kind, error, traceback):
        if self._finished:
            return
        if kind is None:
            await self.commit()
        else:
            await self.rollback()

    async def commit(self):
        try:
            ticket = await self._before_commit(self._transaction)
            result = await self._transaction.commit()
        except BaseException:
            await self._transaction.rollback()
            raise
        finally:
            self._finished = True
            await self._lifetime.aclose()
        await self._after_commit(ticket)
        return result

    async def rollback(self):
        try:
            return await self._transaction.rollback()
        finally:
            self._finished = True
            await self._lifetime.aclose()

    async def close(self):
        try:
            return await self._transaction.close()
        finally:
            self._finished = True
            await self._lifetime.aclose()

    def __getattr__(self, name):
        return getattr(self._transaction, name)


class _MaintenanceDriver:
    """Unguarded access for the format check and its migrations only."""

    def __init__(self, driver: ManagedNeo4jDriver):
        self._driver = driver

    async def execute_query(self, cypher_query_, **kwargs):
        return await Neo4jDriver.execute_query(self._driver, cypher_query_, **kwargs)

    def transaction(self):
        return Neo4jDriver.transaction(self._driver)


class _ReadOnlyDriver:
    def __init__(self, driver: ManagedNeo4jDriver):
        self._driver = driver

    async def execute_query(self, cypher_query_, **kwargs):
        kwargs['routing_'] = RoutingControl.READ
        return await Neo4jDriver.execute_query(self._driver, cypher_query_, **kwargs)


async def _completed_index_build() -> None:
    return None


class GraphitiRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.embedder = LocalHashEmbedder(settings.embedding_dim)
        driver = ManagedNeo4jDriver(
            uri=settings.neo4j_uri,
            user=settings.neo4j_user,
            password=settings.neo4j_password,
            database=settings.neo4j_database,
        )
        self.graphiti = Graphiti(
            graph_driver=driver,
            llm_client=AgentStructuredLLM(),
            embedder=self.embedder,
            cross_encoder=LocalLexicalReranker(),
            store_raw_episode_content=False,
        )
        from .replica_write_guard import ReplicaWriteGuard
        driver.replica_guard = ReplicaWriteGuard(settings.global_replica, observe=settings.replica_write_observation)
        if any(getattr(settings, key, None) for key in ('project_gate_space', 'project_gate_directory', 'project_installation_directory')):
            from .project_write_gate import write_admission
            driver.write_admission = write_admission(settings)

    @property
    def driver(self):
        return self.graphiti.driver

    @property
    def data_format(self):
        return self.driver.format

    async def initialize(self) -> None:
        """Check the graph's data format before any schema change or write."""
        await self.refresh_data_format()

    async def refresh_data_format(self) -> None:
        """Decide again what the provider may do: at start, and after a person
        applied or undid a migration (graph_format_routes.py)."""
        from .project_write_gate import write_admission
        try:
            async with write_admission(self.settings, maintenance=True)():
                self.driver.format = await prepare_graph_format(self.driver.maintenance(), self.settings)
        except HTTPException as exc:
            if not isinstance(exc.detail, dict) or exc.detail.get('code') not in ('project_scope_unknown', 'project_installation_unavailable'):
                raise
            from .graph_format import frozen_graph_format
            self.driver.format = await frozen_graph_format(self.driver.read_only())
        guard = self.driver.replica_guard
        async with guard.held_for_import():
            guard.inventory_known = False
            if self.driver.format.access == 'none':
                return
            try:
                async with asyncio.timeout(3):
                    async with self.driver.read_transaction() as transaction:
                        present = await guard.has_copies(transaction)
            except (TimeoutError, Neo4jError, ServiceUnavailable, SessionExpired):
                logger.warning('Replica inventory could not be checked at startup')
            else:
                async with self.driver.read_transaction() as transaction:
                    if present:
                        await guard.refresh(transaction)
                    else:
                        await guard.refresh_empty(transaction)
        if self.driver.format.access == 'write' and guard.inventory_known:
            from .project_write_gate import project_targets
            from .project_installation import installation
            with installation(self.settings, inspecting=True) as (resolved, enrollment):
                if enrollment and enrollment['phase'] == 'preparing':
                    return
                if enrollment and enrollment['phase'] == 'active':
                    guard.enable_observation()
                space = getattr(resolved, 'project_gate_space', None)
            if space:
                with project_targets(space, []):
                    await self._ensure_personal_space_defaults()
            else:
                await self._ensure_personal_space_defaults()

    async def _ensure_personal_space_defaults(self) -> None:
        """Every personal space has its recruitment policy and system Agents,
        and no Agent keeps a name key that no longer says its name (an older
        FULI renamed it; clear_stale_name_keys). That clearing is a tidy-up: if
        it fails, the space still gets its defaults and the next start retries.

        Not a format migration: the same idempotent defaults are also ensured
        on demand when a space's Project Agents are listed or recruited, and
        this runs only once the graph is writable.

        While `global` is another computer's (config.global_replica), all of
        it is skipped: the policy, the system Agents (with retiring the old
        coordinator) and the name-key tidy-up are `global` records, which its
        owner's copy brings (global_replica.py).
        """
        if self.settings.global_replica:
            logger.info('global is a copy of another computer here: its default records are not written')
            return
        await self.driver.execute_query(
            '''
            MATCH (space:FuliSpace {kind: 'personal'})
            MERGE (policy:FuliProjectAgentRecruitmentPolicy {
              personal_space_id: space.id
            })
            ON CREATE SET policy.confirmation_mode = 'automatic',
                          policy.updated_at = datetime()
            MERGE (space)-[:HAS_PROJECT_AGENT_RECRUITMENT_POLICY]->(policy)
            '''
        )
        records, _, _ = await self.driver.execute_query(
            "MATCH (space:FuliSpace {kind: 'personal'}) RETURN space.id AS space_id",
            routing_='r',
        )
        from .store_project_agent_naming import clear_stale_name_keys
        from .system_agents import ensure_system_agents

        for record in records:
            space_id = record['space_id']
            try:
                await clear_stale_name_keys(self.driver, space_id)
            except Exception as error:
                # A tidy-up: a failure must not keep this or any later space
                # from its defaults. Driver messages may quote a name; log
                # only what failed.
                logger.warning(
                    'clearing stale Agent name keys in personal space %s failed (%s %s); '
                    'retried at the next start',
                    space_id, type(error).__name__, getattr(error, 'code', None) or '-',
                )
            await ensure_system_agents(self.driver, self.settings.provider_id, space_id)

    async def close(self) -> None:
        await self.graphiti.close()
