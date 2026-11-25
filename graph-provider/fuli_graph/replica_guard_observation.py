"""Aggregate opt-in replica check timings. Never retain record or project identifiers."""
from collections import Counter
from time import monotonic


class ReplicaGuardObservation:
    def __init__(self):
        self.checked = 0
        self.changed = Counter()
        self.skipped = Counter()
        self.total_ms = 0.0
        self.max_ms = 0.0

    def record(self, started, problem):
        elapsed = (monotonic() - started) * 1000
        self.checked += 1
        self.total_ms += elapsed
        self.max_ms = max(self.max_ms, elapsed)
        if problem:
            scopes = problem[2]
            for kind in {'global' if scope == 'global' else 'project' for scope in scopes} or {'unknown'}:
                self.changed[kind] += 1

    def status(self):
        return {'checked': self.checked, 'changedByScope': dict(self.changed), 'skipped': dict(self.skipped),
                'totalMs': round(self.total_ms, 2), 'maxMs': round(self.max_ms, 2)}
