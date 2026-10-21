"""Metrics registry and the ``/api/v1/metrics`` contract.

The registry is deliberately small, but it is the thing a developer will look
at when a request is mysteriously slow, so the arithmetic (nearest-rank
percentiles, the bounded sample window) is pinned here.
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from backend.app.observability import MAX_SAMPLES, MetricsRegistry


class FakeClock:
    def __init__(self, start: float = 100.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


def test_requests_are_counted_by_status_and_method() -> None:
    registry = MetricsRegistry()
    registry.observe("GET", 200, 4.0)
    registry.observe("GET", 200, 8.0)
    registry.observe("POST", 422, 12.0)
    registry.observe("GET", 500, 20.0)

    snapshot = registry.snapshot()

    assert snapshot["requests"]["total"] == 4
    assert snapshot["requests"]["errors_5xx"] == 1
    assert snapshot["requests"]["by_status"] == {"200": 2, "422": 1, "500": 1}
    assert snapshot["requests"]["by_method"] == {"GET": 3, "POST": 1}
    assert snapshot["latency_ms"]["samples"] == 4
    assert snapshot["latency_ms"]["max"] == 20.0


def test_percentiles_are_nearest_rank_over_the_window() -> None:
    registry = MetricsRegistry()
    for value in range(1, 101):
        registry.observe("GET", 200, float(value))

    latency = registry.snapshot()["latency_ms"]

    assert latency["samples"] == 100
    assert latency["mean"] == pytest.approx(50.5)
    # Nearest rank: p50 is the 50th value, not an interpolation.
    assert latency["p50"] == 50.0
    assert latency["p95"] == 95.0
    assert latency["p99"] == 99.0
    assert latency["max"] == 100.0
    assert latency["p50"] <= latency["p95"] <= latency["p99"] <= latency["max"]


def test_the_sample_window_is_bounded_and_the_mean_follows_it() -> None:
    registry = MetricsRegistry()
    for value in range(1, 3001):
        registry.observe("GET", 200, float(value))

    latency = registry.snapshot()["latency_ms"]

    assert latency["samples"] == MAX_SAMPLES
    # Only the last MAX_SAMPLES observations remain, so the mean is the mean
    # of 953..3000, not of 1..3000.
    assert latency["mean"] == pytest.approx((953 + 3000) / 2, abs=0.01)
    assert latency["max"] == 3000.0


def test_cache_counters_and_uptime() -> None:
    clock = FakeClock()
    registry = MetricsRegistry(clock=clock)
    registry.cache_hit()
    registry.cache_hit()
    registry.cache_miss()
    registry.cache_build()
    registry.cache_invalidation()
    clock.now += 5.0

    snapshot = registry.snapshot()

    assert snapshot["analytics_cache"] == {
        "hits": 2,
        "misses": 1,
        "builds": 1,
        "invalidations": 1,
    }
    assert snapshot["uptime_seconds"] == 5.0
    assert snapshot["window"]["latency_samples"] == MAX_SAMPLES


def test_an_empty_registry_reports_zeroes_not_nulls() -> None:
    latency = MetricsRegistry().snapshot()["latency_ms"]

    assert latency == {"samples": 0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0}


def test_metrics_endpoint_reports_traffic_without_leaking_requests(
    empty_client: Any,
) -> None:
    before = empty_client.get("/api/v1/metrics")
    assert before.status_code == 200
    assert before.headers["cache-control"] == "no-store"
    baseline = before.json()

    assert empty_client.get("/api/v1/health").status_code == 200
    after = empty_client.get("/api/v1/metrics").json()

    assert after["version"]
    assert after["process"]
    assert after["requests"]["total"] >= baseline["requests"]["total"] + 2
    assert after["requests"]["by_method"].get("GET", 0) >= 2
    assert after["requests"]["by_status"].get("200", 0) >= 2
    assert after["latency_ms"]["samples"] >= 1
    assert after["uptime_seconds"] >= 0
    assert set(after["analytics_cache"]) == {"hits", "misses", "builds", "invalidations"}
    assert after["latency_ms"]["p95"] >= after["latency_ms"]["p50"]

    # The registry stores counters, not requests: no path, query or key can
    # appear in the payload.
    body = json.dumps(after).lower()
    for forbidden in ("api_key", "authorization", "ticker", "portfolio_id", "/api/v1/"):
        assert forbidden not in body


def test_metrics_requires_the_api_key_when_one_is_configured(
    empty_client: Any, temp_settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from backend.app import api

    secured = replace(temp_settings, api_key="s3cret")
    monkeypatch.setattr(api, "SETTINGS", secured)
    monkeypatch.setattr(api, "_service", api.AnalyticsService(secured))

    assert empty_client.get("/api/v1/metrics").status_code == 401
    authorised = empty_client.get("/api/v1/metrics", headers={"X-API-Key": "s3cret"})
    assert authorised.status_code == 200
