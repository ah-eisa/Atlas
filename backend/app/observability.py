"""Operational metrics for the analytics service.

A small in-process registry, deliberately dependency-free: the service is a
single-user process, and a Prometheus client would add a deployment contract
(scrape configuration, retention, a second port) that this project does not
need. The counters are exposed as JSON on ``/api/v1/metrics`` so a developer or
a local monitoring job can read them without extra infrastructure.

What is measured, and what is not:

* Request count, status-class counts, method counts and 5xx errors.
* Latency in milliseconds over the most recent ``MAX_SAMPLES`` API requests:
  mean, p50, p95, p99 and max. Percentiles are exact over that window, not
  estimates.
* Analytics cache hits, misses, builds and invalidations, so an unexpected
  rebuild (a cache key that changes too often) is visible.
* Only paths under ``/api/`` are recorded. Static assets are not interesting
  and would dominate the sample.

No request path, query string, header, API key, portfolio id or ticker is kept:
the registry cannot leak what it never stores.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from typing import Any

# A power of two that covers roughly a working day of interactive traffic
# without letting the registry grow without bound.
MAX_SAMPLES: int = 2048

_PERCENTILES: tuple[tuple[str, float], ...] = (("p50", 0.50), ("p95", 0.95), ("p99", 0.99))


class MetricsRegistry:
    """Thread-safe counters and latency samples.

    FastAPI runs synchronous endpoints in a thread pool, so every mutation and
    the snapshot are guarded by the same lock.
    """

    def __init__(self, *, clock: Any = time.monotonic) -> None:
        self._clock = clock
        self._started = clock()
        self._lock = threading.Lock()
        self._requests_total = 0
        self._errors_5xx = 0
        self._by_status: dict[str, int] = {}
        self._by_method: dict[str, int] = {}
        self._latencies: deque[float] = deque(maxlen=MAX_SAMPLES)
        self._latency_sum = 0.0
        self._latency_max = 0.0
        self._cache = {"hits": 0, "misses": 0, "builds": 0, "invalidations": 0}

    # -- recording ---------------------------------------------------------

    def observe(self, method: str, status: int, duration_ms: float) -> None:
        """Record one completed API request."""
        duration = max(0.0, float(duration_ms))
        with self._lock:
            self._requests_total += 1
            self._by_status[str(status)] = self._by_status.get(str(status), 0) + 1
            key = method.upper()
            self._by_method[key] = self._by_method.get(key, 0) + 1
            if status >= 500:
                self._errors_5xx += 1
            if len(self._latencies) == self._latencies.maxlen:
                # deque(maxlen) drops the oldest value on append; keep the
                # running sum consistent with what remains.
                self._latency_sum -= self._latencies[0]
            self._latencies.append(duration)
            self._latency_sum += duration
            self._latency_max = max(self._latency_max, duration)

    def cache_hit(self) -> None:
        with self._lock:
            self._cache["hits"] += 1

    def cache_miss(self) -> None:
        with self._lock:
            self._cache["misses"] += 1

    def cache_build(self) -> None:
        with self._lock:
            self._cache["builds"] += 1

    def cache_invalidation(self) -> None:
        with self._lock:
            self._cache["invalidations"] += 1

    # -- reading -----------------------------------------------------------

    def _percentile(self, ordered: list[float], fraction: float) -> float:
        if not ordered:
            return 0.0
        # Nearest-rank on the sorted window: no interpolation, so every value
        # reported is a latency that actually happened.
        index = max(0, math.ceil(fraction * len(ordered)) - 1)
        return ordered[index]

    def snapshot(self) -> dict[str, Any]:
        """A consistent copy of every counter, safe to serialise."""
        with self._lock:
            ordered = sorted(self._latencies)
            samples = len(ordered)
            mean = (self._latency_sum / samples) if samples else 0.0
            latency = {
                "samples": samples,
                "mean": round(mean, 2),
                **{name: round(self._percentile(ordered, f), 2) for name, f in _PERCENTILES},
                "max": round(self._latency_max, 2),
            }
            return {
                "uptime_seconds": round(max(0.0, self._clock() - self._started), 3),
                "requests": {
                    "total": self._requests_total,
                    "errors_5xx": self._errors_5xx,
                    "by_status": dict(sorted(self._by_status.items())),
                    "by_method": dict(sorted(self._by_method.items())),
                },
                "latency_ms": latency,
                "analytics_cache": dict(self._cache),
                "window": {"latency_samples": MAX_SAMPLES},
            }


# One registry per process. Tests construct their own where isolation matters.
METRICS = MetricsRegistry()
