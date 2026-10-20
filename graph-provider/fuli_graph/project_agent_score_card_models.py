"""Contract of Bole's zero-token score card: separate dimensions, each with its sample."""

from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, Field, field_validator

from .model_base import StrictModel
from .model_validation import unique_text_list


ScoreDimension = Literal['completion', 'first_pass', 'user_feedback', 'review']
ScoreTierLabel = Literal['S', 'A', 'B', 'C']
ReviewVerdictResult = Literal['passed', 'not_passed', 'disputed']
# The host sends at most this many review verdicts per read; it keeps the newest.
MAX_REVIEW_VERDICTS = 2000


class ProjectAgentReviewVerdict(StrictModel):
    """A review verdict the host recorded about one task (Tonborg acceptance).

    ``disputed`` is a verdict the user has thumbed down: it is counted as a
    correction and never as a pass or a failure. The artifact revision and
    verification attempt it judged decide whether it is still current.
    """

    task_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    result: ReviewVerdictResult
    artifact_revision: str = Field(min_length=1, max_length=160)
    verification_attempt_id: str = Field(min_length=1, max_length=128)
    occurred_at: AwareDatetime | None = None


class ProjectAgentScoreCardQuery(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    # None reads every project of the space; an explicit list, even empty, is the scope.
    personal_project_ids: list[str] | None = Field(default=None, max_length=500)
    review_verdicts: list[ProjectAgentReviewVerdict] = Field(
        default_factory=list, max_length=MAX_REVIEW_VERDICTS)

    @field_validator('personal_project_ids')
    @classmethod
    def validate_project_ids(cls, value):
        return None if value is None else unique_text_list(value, 'score card project IDs', maximum=128)


class ProjectAgentScoreEvidenceQuery(ProjectAgentScoreCardQuery):
    dimension: ScoreDimension
    executor_id: str | None = Field(default=None, min_length=1, max_length=128)
    limit: int = Field(default=50, ge=1, le=200)


class ProjectAgentScoreTier(StrictModel):
    """A display label only; it is never a basis for an automatic action."""

    label: ScoreTierLabel
    evidence_count: int = Field(ge=1)


class ProjectAgentScoreDimension(StrictModel):
    status: Literal['scored', 'insufficient_data']
    sample: int = Field(ge=0)
    passed: int | None = Field(default=None, ge=0)
    rate: float | None = Field(default=None, ge=0, le=1)
    tier: ProjectAgentScoreTier | None = None
    # 数据不足 when the sample is below the minimum: no rate, tier or conclusion.
    label: str | None = None


class ProjectAgentScoreDimensions(StrictModel):
    completion: ProjectAgentScoreDimension
    first_pass: ProjectAgentScoreDimension
    user_feedback: ProjectAgentScoreDimension
    review: ProjectAgentScoreDimension


class ProjectAgentToolFlag(StrictModel):
    """Poor on one executor while fine on another: change the tool, not the Agent."""

    dimension: ScoreDimension
    executor_id: str
    rate: float = Field(ge=0, le=1)
    sample: int = Field(ge=1)
    compared_executor_id: str
    compared_rate: float = Field(ge=0, le=1)
    compared_sample: int = Field(ge=1)
    suggestion: Literal['change_executor_or_model'] = 'change_executor_or_model'


class ProjectAgentScoreExecutor(StrictModel):
    executor_id: str
    evidence_count: int = Field(ge=1)


class ProjectAgentScoreCard(StrictModel):
    personal_space_id: str
    agent_id: str
    personal_project_ids: list[str] | None
    minimum_sample: int
    dimensions: ProjectAgentScoreDimensions
    executors: list[ProjectAgentScoreExecutor]
    tool_flags: list[ProjectAgentToolFlag]
    disputed_review_count: int = Field(ge=0)
    # Verdicts on an artifact or verification that has since been superseded.
    stale_review_count: int = Field(ge=0)
    as_of: datetime


class ProjectAgentScoreTaskList(StrictModel):
    """``count`` matches the card; ``task_ids`` are distinct, newest first."""

    count: int = Field(ge=0)
    task_ids: list[str]


class ProjectAgentScoreEvidence(StrictModel):
    personal_space_id: str
    agent_id: str
    personal_project_ids: list[str] | None
    dimension: ScoreDimension
    executor_id: str | None
    passed: ProjectAgentScoreTaskList
    not_passed: ProjectAgentScoreTaskList
    truncated: bool
