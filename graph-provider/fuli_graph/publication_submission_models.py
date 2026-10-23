"""Provider transport decisions; these are not Agent tool decisions."""
from typing import Literal

from pydantic import Field, model_validator

from .model_base import StrictModel


class PublicationSubmissionError(StrictModel):
    code: str = Field(min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_.:-]+$')


class PublicationLookupResult(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    status: Literal['pending', 'processing', 'approved', 'rejected']


class PublicationSubmissionDecision(StrictModel):
    decision: Literal['begin_submit_public', 'submit_public', 'release_submit_public',
                      'mark_submission_unknown', 'reconcile_submit_public', 'keep_personal', 'ignore']
    submission_id: str | None = Field(default=None, min_length=1, max_length=128)
    shared_proposal_id: str | None = Field(default=None, min_length=1, max_length=128)
    last_submission_error: PublicationSubmissionError | None = None
    lookup_result: PublicationLookupResult | None = None

    @model_validator(mode='after')
    def valid_submission_transition(self):
        needs_attempt = self.decision not in ('begin_submit_public', 'keep_personal', 'ignore')
        if needs_attempt != bool(self.submission_id):
            raise ValueError('submission_id is required except when beginning a submission')
        if (self.decision == 'submit_public') != bool(self.shared_proposal_id):
            raise ValueError('shared_proposal_id is required only when finishing a submission')
        if self.last_submission_error and self.decision != 'release_submit_public':
            raise ValueError('last_submission_error is only valid when releasing a submission')
        if ('lookup_result' in self.model_fields_set) != (self.decision == 'reconcile_submit_public'):
            raise ValueError('lookup_result must be supplied only for reconciliation, including null')
        return self
