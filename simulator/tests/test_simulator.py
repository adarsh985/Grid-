"""Unit tests for the GridSense Smart-Meter Simulator (Phase 1)."""

import csv
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from simulator.engine import SmartMeterSimulator
from simulator.models import FaultType, PHYSICAL_BOUNDS
from simulator.transports import CsvFileTransport, HttpPostTransport, InMemoryQueueTransport


def test_default_meter_count_and_three_phases():
    """Verify default simulator initializes 20 meters with 3-phase telemetry fields."""
    sim = SmartMeterSimulator(seed=101)
    assert len(sim.meter_ids) == 20

    ts = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    batch = sim.generate_step(ts)
    assert len(batch) == 20

    sample = batch[0]
    assert sample.meter_id == "MTR-001"
    assert sample.timestamp == "2026-06-15T12:00:00Z"
    assert hasattr(sample, "voltage_a")
    assert hasattr(sample, "voltage_b")
    assert hasattr(sample, "voltage_c")
    assert hasattr(sample, "current_a")
    assert hasattr(sample, "current_b")
    assert hasattr(sample, "current_c")


def test_all_values_stay_within_physical_ranges():
    """Verify readings under both normal and high-fault probability remain within physical bounds."""
    sim = SmartMeterSimulator(num_meters=20, fault_probability=0.35, seed=2026)
    ts = datetime(2026, 6, 15, 19, 30, 0, tzinfo=timezone.utc)

    for _ in range(150):
        batch = sim.generate_step(ts, step_seconds=60.0)
        for r in batch:
            for v in (r.voltage_a, r.voltage_b, r.voltage_c):
                assert PHYSICAL_BOUNDS["voltage_min"] <= v <= PHYSICAL_BOUNDS["voltage_max"]
            for c in (r.current_a, r.current_b, r.current_c):
                assert PHYSICAL_BOUNDS["current_min"] <= c <= PHYSICAL_BOUNDS["current_max"]
            assert PHYSICAL_BOUNDS["power_factor_min"] <= r.power_factor <= PHYSICAL_BOUNDS["power_factor_max"]
            assert PHYSICAL_BOUNDS["frequency_min"] <= r.frequency <= PHYSICAL_BOUNDS["frequency_max"]
            assert r.active_energy_kwh > 0


def test_daily_load_curve_night_vs_evening_peak():
    """Verify daily load curve is significantly lower at night (03:00) than evening peak (20:00)."""
    sim = SmartMeterSimulator(num_meters=10, fault_probability=0.0, seed=7)
    night_ts = datetime(2026, 6, 15, 3, 0, 0, tzinfo=timezone.utc)
    evening_ts = datetime(2026, 6, 15, 20, 0, 0, tzinfo=timezone.utc)

    night_batch = sim.generate_step(night_ts)
    evening_batch = sim.generate_step(evening_ts)

    avg_night_current = sum(r.current_a for r in night_batch) / len(night_batch)
    avg_evening_current = sum(r.current_a for r in evening_batch) / len(evening_batch)

    assert avg_evening_current > avg_night_current * 2.2


@pytest.mark.parametrize(
    "fault_type",
    [
        FaultType.PHASE_IMBALANCE,
        FaultType.OVERCURRENT_SPIKE,
        FaultType.HARMONIC_DISTORTION,
        FaultType.POWER_THEFT,
        FaultType.VOLTAGE_SAG,
        FaultType.VOLTAGE_SWELL,
    ],
)
def test_forced_fault_injection_appears_in_labels_and_shifts_signals(fault_type: FaultType):
    """Verify each injected fault type is recorded in fault_label and produces expected physical signature."""
    sim = SmartMeterSimulator(num_meters=1, fault_probability=0.0, seed=99)
    ts = datetime(2026, 6, 15, 14, 0, 0, tzinfo=timezone.utc)

    # Baseline normal reading
    normal_reading = sim.generate_reading_for_meter("MTR-001", ts)
    assert normal_reading.fault_label == FaultType.NORMAL.value

    # Force specific fault
    sim.force_fault("MTR-001", fault_type=fault_type, duration_steps=2, affected_phase="B")
    fault_reading = sim.generate_reading_for_meter("MTR-001", ts)
    assert fault_reading.fault_label == fault_type.value

    if fault_type == FaultType.PHASE_IMBALANCE:
        # Phase B current deviates noticeably from Phase A & C
        mean_ac = (fault_reading.current_a + fault_reading.current_c) / 2.0
        deviation_ratio = abs(fault_reading.current_b - mean_ac) / mean_ac
        assert deviation_ratio >= 0.12

    elif fault_type == FaultType.OVERCURRENT_SPIKE:
        assert fault_reading.current_a > normal_reading.current_a * 1.8

    elif fault_type == FaultType.HARMONIC_DISTORTION:
        assert fault_reading.power_factor < 0.78

    elif fault_type == FaultType.POWER_THEFT:
        # Current drops 30-60% while voltage remains near 230V normal
        assert fault_reading.current_a < normal_reading.current_a * 0.75
        assert 220.0 <= fault_reading.voltage_a <= 240.0

    elif fault_type == FaultType.VOLTAGE_SAG:
        assert fault_reading.voltage_a < 205.0

    elif fault_type == FaultType.VOLTAGE_SWELL:
        assert fault_reading.voltage_a > 252.0


def test_probabilistic_fault_injection_covers_all_fault_types():
    """Verify stochastic fault injection produces all fault classes across steps."""
    sim = SmartMeterSimulator(num_meters=20, fault_probability=0.15, seed=1234)
    ts = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)

    seen_labels = set()
    for _ in range(80):
        for r in sim.generate_step(ts):
            seen_labels.add(r.fault_label)

    for ft in FaultType:
        assert ft.value in seen_labels, f"Expected fault type {ft.value} to appear in generated stream"


def test_pluggable_transports_in_memory_and_http():
    """Verify pluggable transport interface with InMemoryQueueTransport and HttpPostTransport."""
    sim = SmartMeterSimulator(num_meters=5, fault_probability=0.05, seed=11)
    mem_transport = InMemoryQueueTransport()
    sim.run_stream(transport=mem_transport, interval_sec=0.0, max_steps=3)

    assert len(mem_transport.batches) == 3
    assert len(mem_transport.all_readings) == 15

    with patch("requests.Session.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        http_transport = HttpPostTransport(endpoint_url="http://localhost:4000/api/readings")
        ok = http_transport.send_batch(mem_transport.batches[0])
        http_transport.close()

        assert ok is True
        assert mock_post.call_count == 1


def test_historical_csv_generation(tmp_path: Path):
    """Verify historical CSV export writes valid headers and expected row count."""
    csv_path = tmp_path / "historical_test.csv"
    sim = SmartMeterSimulator(num_meters=4, fault_probability=0.10, seed=55)

    # 2 days at 60-minute intervals = 48 steps * 4 meters = 192 rows
    rows_written = sim.generate_historical_csv(
        output_path=csv_path,
        days=2,
        interval_minutes=60,
    )
    assert rows_written == 192
    assert csv_path.exists()

    with csv_path.open("r", encoding="utf-8") as f:
        reader = list(csv.DictReader(f))
    assert len(reader) == 192
    assert set(reader[0].keys()) == set(CsvFileTransport.FIELDNAMES)
