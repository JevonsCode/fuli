"""Aggregate opt-in replica check timings. Never retain record or project identifiers."""
from collections import Counter, deque
from math import ceil
from time import monotonic


class ReplicaGuardObservation:
    def __init__(self):
        self.checked = 0
        self.changed = Counter()
        self.skipped = Counter()
        self.total_ms = 0.0
        self.max_ms = 0.0
        self.recent_ms = deque(maxlen=256)

    def record(self, started, problem):
        elapsed = (monotonic() - started) * 1000
        self.recent_ms.append(elapsed)
        self.checked += 1
        self.total_ms += elapsed
        self.max_ms = max(self.max_ms, elapsed)
        if problem:
            scopes = problem[2]
            for kind in {'global' if scope == 'global' else 'project' for scope in scopes} or {'unknown'}:
                self.changed[kind] += 1

    def status(self):
        samples = sorted(self.recent_ms)
        def percentile(fraction):
            return round(samples[ceil(len(samples) * fraction) - 1], 2) if samples else None
        return {'recentSampleCount': len(samples), 'p50Ms': percentile(0.5), 'p95Ms': percentile(0.95),
                'checked': self.checked, 'changedByScope': dict(self.changed), 'skipped': dict(self.skipped),
                'totalMs': round(self.total_ms, 2), 'maxMs': round(self.max_ms, 2)}
