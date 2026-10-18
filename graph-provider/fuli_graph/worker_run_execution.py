"""Host execution evidence and the CL-approved bounded retry policy."""
from datetime import timedelta

from .provider_values import now_utc

# Trusted deployment constants; deliberately absent from model-facing schemas.
WORKER_RETRY_MAX_ATTEMPTS = 2
WORKER_NETWORK_MAX_ATTEMPTS = 3
WORKER_FINAL_RETRY_DELAY_MS = 5000

FAILURE_CLASSES = {
    'worker_connection_closed': 'network',
    'worker_runtime_offline': 'runtime', 'worker_runtime_recovery': 'runtime',
    'worker_authentication_required': 'authentication', 'worker_authentication_unknown': 'authentication',
    'worker_workspace_untrusted': 'configuration', 'worker_model_strategy_unmapped': 'configuration',
    'worker_model_unavailable': 'model', 'worker_model_mismatch': 'model',
    'worker_cancelled': 'cancelled', 'worker_timeout': 'timeout',
    'worker_identity_mismatch': 'authority', 'worker_authority_unavailable': 'authority',
    'worker_cleanup_incomplete': 'cleanup', 'worker_host_finalization_incomplete': 'cleanup',
    'worker_result_mismatch': 'execution', 'worker_checkpoint_failed': 'execution',
}

# Existing close reasons were free text. New read projections must not turn
# those diagnostics into a capability/credential disclosure surface.
PUBLIC_WORKER_CODES = frozenset(FAILURE_CLASSES) | {
    'worker_checkpoint_completed', 'worker_checkpoint_missing', 'worker_checkpoint_incomplete',
    'worker_prompt_incomplete', 'worker_transport_failed', 'worker_start_not_claimed',
    'worker_dispatch_not_claimed', 'worker_unknown',
} | {f'worker_{stage}_failed' for stage in (
    'lease', 'parent', 'prepare', 'claim', 'start', 'session', 'seal', 'admit',
    'configure', 'running_activity', 'dispatch', 'prompt', 'checkpoint')}


def execution_result_fields(request, run):
    result = request.model_dump(exclude={'personal_space_id', 'personal_project_id'})
    category = FAILURE_CLASSES.get(request.code, 'unknown') if request.status != 'completed' else None
    limit = run.get('retry_limit') or (WORKER_NETWORK_MAX_ATTEMPTS if category == 'network' else WORKER_RETRY_MAX_ATTEMPTS)
    number = run.get('attempt_number')
    eligible = bool(request.status == 'failed' and category in {'network', 'runtime'}
                    and request.stage in {'start', 'session', 'seal', 'admit', 'configure', 'running_activity'}
                    and not request.prompt_dispatched and not run.get('prompt_dispatched_at')
                    and request.process_stopped and request.run_closed and request.terminal_recorded
                    and not request.cleanup_errors and run.get('state') == 'closed'
                    and isinstance(number, int) and number < limit)
    delay = WORKER_FINAL_RETRY_DELAY_MS if eligible and category == 'network' and number + 1 == limit else 0
    return {**result, 'failure_class': category, 'retry_eligible': eligible,
            'attempt_limit': limit,
            'retry_not_before': (now_utc() + timedelta(milliseconds=delay)).isoformat() if eligible else None}
