"""Read Bole's score card from recorded outcomes; never writes, never calls a model."""

from __future__ import annotations

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_score_card import (
    review_verdict_facts,
    score_card_sections,
    score_evidence_sections,
    score_facts,
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
        agent_id, facts, review = await self._project_agent_score_facts(actor, query)
        return ProjectAgentScoreCard(
            personal_space_id=query.personal_space_id, agent_id=agent_id,
            personal_project_ids=query.personal_project_ids,
            disputed_review_count=review.disputed, stale_review_count=review.stale,
            as_of=now_utc(), **score_card_sections(facts))

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
        current_tasks = await self._agent_task_evidence_versions(
            query.personal_space_id, agent_id, sorted({verdict.task_id for verdict in verdicts}))
        review = review_verdict_facts(verdicts, current_tasks)
        return agent_id, score_facts(aggregates, evidence, review), review

    async def _agent_task_evidence_versions(self, space_id, agent_id, task_ids) -> dict[str, dict]:
        """The Agent's tasks with their current verification and newest observed artifact."""
        if not task_ids:
            return {}
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                  -[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent {agent_id: $agent_id})
            MATCH (task:FuliProjectAgentTask {personal_space_id: $personal_space_id})
                  -[:HAS_PARTICIPANT]->(agent)
            WHERE task.task_id IN $task_ids
            OPTIONAL MATCH (task)-[:HAS_EXECUTOR_OBSERVATION]->(observation:FuliProjectAgentExecutorObservation)
            WHERE observation.artifact_revision IS NOT NULL
            WITH task, observation ORDER BY observation.occurred_at DESC
            WITH task, collect(observation.artifact_revision) AS observed_artifacts
            RETURN task.task_id AS task_id, task.personal_project_id AS personal_project_id,
                   task.verified_artifact_revision AS verified_artifact_revision,
                   task.verified_attempt_id AS verified_attempt_id,
                   observed_artifacts[0] AS current_artifact_revision
            ''',
            personal_space_id=space_id, agent_id=agent_id, task_ids=task_ids, routing_='r',
        )
        return {row['task_id']: {key: row[key] for key in (
            'personal_project_id', 'verified_artifact_revision', 'verified_attempt_id',
            'current_artifact_revision')} for row in records}
