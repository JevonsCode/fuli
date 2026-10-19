"""HTTP reads of Bole's zero-token score card.

They are POST queries because the host supplies the review verdicts it records
locally (Tonborg acceptance); nothing is written.
"""

from typing import Any

from .project_agent_score_card_models import (
    ProjectAgentScoreCard,
    ProjectAgentScoreCardQuery,
    ProjectAgentScoreEvidence,
    ProjectAgentScoreEvidenceQuery,
)


def register_project_agent_score_card_routes(application, store, Actor: Any) -> None:
    @application.post('/v1/project-agent-score-card/query', response_model=ProjectAgentScoreCard)
    async def read_project_agent_score_card(request: ProjectAgentScoreCardQuery, actor: Actor):
        return await store.project_agent_score_card(actor, request)

    @application.post('/v1/project-agent-score-card/evidence', response_model=ProjectAgentScoreEvidence)
    async def read_project_agent_score_evidence(request: ProjectAgentScoreEvidenceQuery, actor: Actor):
        return await store.project_agent_score_evidence(actor, request)
