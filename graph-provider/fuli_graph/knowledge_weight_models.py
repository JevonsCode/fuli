from pydantic import Field

from .model_base import StrictModel


class KnowledgeWeightView(StrictModel):
    """Read-only display metadata; never used as an authorization input."""
    weight_percent: int = Field(default=10, ge=10, le=100)
    confirmed_by_person: bool = False
