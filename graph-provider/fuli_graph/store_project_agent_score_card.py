"""Read Bole's score card from recorded outcomes; never writes, never calls a model."""

from __future__ import annotations

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_score_card import (
    outcome_score_facts,
    review_verdict_facts,
    score_card_sections,
    score_evidence_sections,
)
from .project_agent_score_card_models import (
    ProjectAgentScoreCard,
    ProjectAgentScoreCardQuery,
    ProjectAgentScoreEvidence,
    ProjectAgentScoreEvidenceQuery,
)
from .provider_values import now_utc
from .system_hr_identity import resolve_hr_alias


class StoreProjectAgentScoreCard:
    """Aggregates executor-learning buckets and host review verdicts per Agent."""

    async def project_agent_score_card(
        self, actor: dict, query: ProjectAgentScoreCardQuery,
    ) -> ProjectAgentScoreCard:
        agent_id, facts, disputed = await self._project_agent_score_facts(actor, query)
        return ProjectAgentScoreCard(
            personal_space_id=query.personal_space_id, agent_id=agent_id,
            personal_project_ids=query.personal_project_ids,
            disputed_review_count=disputed, as_of=now_utc(), **score_card_sections(facts))

    async def project_agent_score_evidence(
        self, actor: dict, query: ProjectAgentScoreEvidenceQuery,
    ) -> ProjectAgentScoreEvidence:
        agent_id, facts, _ = await self._project_agent_score_facts(actor, query)
        return ProjectAgentScoreEvidence(
            personal_space_id=query.personal_space_id, agent_id=agent_id,
            personal_project_ids=query.personal_project_ids, dimension=query.dimension,
            executor_id=query.executor_id, **score_evidence_sections(
                facts, dimension=query.dimension, executor_id=query.executor_id, limit=query.limit))

    async def _project_agent_score_facts(self, actor, query):
        self._require_personal()
        space = await self.authorize(actor, query.personal_space_id, 'reader')
        agent_id = await resolve_hr_alias(self, query.personal_space_id, query.agent_id)
        scope = query.personal_project_ids
        for project_id in scope or []:
            await authorize_personal_project(self, actor, space, project_id)
        aggregates = [aggregate for aggregate in await self.list_project_agent_executor_outcome_aggregates(
            actor, query.personal_space_id, agent_id=agent_id)
            if scope is None or aggregate.personal_project_id in scope]
        evidence = []
        for project_id in sorted({aggregate.personal_project_id for aggregate in aggregates}):
            try:
                evidence.extend(await self.list_project_agent_executor_outcome_evidence(
                    actor, query.personal_space_id, project_id, agent_id=agent_id))
            except HTTPException as error:
                # A bucket of a project the owner can no longer read adds nothing.
                if error.status_code != 404:
                    raise
        verdicts = [verdict for verdict in query.review_verdicts
                    if scope is None or verdict.personal_project_id in scope]
        participant_projects = await self._agent_participant_projects(
            query.personal_space_id, agent_id, sorted({verdict.task_id for verdict in verdicts}))
        review_facts, disputed = review_verdict_facts(verdicts, participant_projects)
        return agent_id, outcome_score_facts(aggregates, evidence) + review_facts, disputed

    async def _agent_participant_projects(self, space_id, agent_id, task_ids) -> dict[str, str]:
        if not task_ids:
            return {}
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                  -[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent {agent_id: $agent_id})
            MATCH (task:FuliProjectAgentTask {personal_space_id: $personal_space_id})
                  -[:HAS_PARTICIPANT]->(agent)
            WHERE task.task_id IN $task_ids
            RETURN task.task_id AS task_id, task.personal_project_id AS personal_project_id
            ''',
            personal_space_id=space_id, agent_id=agent_id, task_ids=task_ids, routing_='r',
        )
        return {row['task_id']: row['personal_project_id'] for row in records}
