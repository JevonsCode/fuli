"""Host-only admission contracts for one worker session and one prompt attempt."""

from typing import Literal

from pydantic import Field, StrictBool, field_validator

from .models import SourceApplication, StrictModel
from .project_agent_models import ProjectAgentModelStrategy


class WorkerRunScope(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)


class WorkerRunPrepare(WorkerRunScope):
    task_context_token: str = Field(pattern=r'^fuli-task-[a-zA-Z0-9-]{8,128}$')
    source_application: SourceApplication
    task_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    worker_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    target_application: SourceApplication
    provider: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=256)
    model_strategy: ProjectAgentModelStrategy
    idempotency_key: str = Field(min_length=8, max_length=256)
    runtime_capability_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    bootstrap_lifetime_seconds: int = Field(default=300, ge=30, le=900)
    retry_of_run_id: str | None = Field(default=None, min_length=1, max_length=128)


class WorkerRunSession(WorkerRunScope):
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)

    @field_validator('session_id')
    @classmethod
    def require_session(cls, value):
        if not value.strip():
            raise ValueError('Worker session ID must not be blank')
        return value


class WorkerRunClose(WorkerRunScope):
    reason: str = Field(min_length=1, max_length=512)


class WorkerRunResult(WorkerRunScope):
    status: Literal['completed', 'incomplete', 'blocked', 'cancelled', 'failed']
    code: str = Field(pattern=r'^worker_[a-z0-9_]{1,96}$')
    stage: Literal['lease', 'parent', 'prepare', 'claim', 'start', 'session', 'seal',
                   'admit', 'configure', 'running_activity', 'dispatch', 'prompt', 'checkpoint']
    prompt_dispatched: StrictBool
    process_stopped: StrictBool
    run_closed: StrictBool
    terminal_recorded: StrictBool
    cleanup_errors: list[Literal['worker_process_cleanup_incomplete', 'worker_run_close_failed',
        'worker_terminal_activity_failed', 'worker_lease_release_failed']] = Field(max_length=8)
