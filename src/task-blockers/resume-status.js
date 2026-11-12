// The statuses a cleared block resumes a task as (rec#123): running, or back to its queue.
export const RESUME_STATUSES = Object.freeze(new Set(['running', 'queued']));
