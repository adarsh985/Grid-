"""Pytest suite for GridSense ML Service (Phase 2)."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

from fastapi.testclient import TestClient
import numpy as np
import pandas as pd
import pytest

ML_DIR = Path(__file__).resolve().parents[1]
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from app import app
from explainability import explain_reading
from features import FEATURE_COLUMNS, build_reference_psi_bins, compute_psi, engineer_features


def _make_sample_readings(n: int = 12, meter_id: str = "MTR-001", base_current: float = 15.0):
    start = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    rows = []
    for i in range(n):
        ts = (start + timedelta(minutes=5 * i)).isoformat().replace("+00:00", "Z")
        rows.append(
            {
                "timestamp": ts,
                "meter_id": meter_id,
                "voltage_a": 230.0 + (i % 3 - 1) * 0.4,
                "voltage_b": 230.2 - (i % 2) * 0.3,
                "voltage_c": 229.8 + (i % 2) * 0.2,
                "current_a": base_current + (i % 3) * 0.2,
                "current_b": base_current + (i % 2) * 0.15,
                "current_c": base_current - (i % 2) * 0.1,
                "power_factor": 0.95,
                "frequency": 50.0,
                "active_energy_kwh": 1000.0 + i * 1.5,
            }
        )
    return rows


def test_feature_engineering_columns_and_nema_imbalance():
    """Verify rolling windows, per-phase ratios, NEMA imbalance, PF deviation, and RoC."""
    rows = _make_sample_readings(n=15)
    # Inject a phase imbalance on Phase B in the last reading
    rows[-1]["current_b"] = 25.0

    df = pd.DataFrame(rows)
    feat_df = engineer_features(df)

    for col in FEATURE_COLUMNS:
        assert col in feat_df.columns, f"Missing engineered feature: {col}"
        assert not feat_df[col].isna().any(), f"NaN values found in {col}"

    # Check NEMA imbalance on last row is significantly elevated
    assert feat_df.iloc[-1]["current_imbalance_nema"] > 0.25
    # Check 60m relative deviation on Phase B current is positive and large
    assert feat_df.iloc[-1]["current_b_rel_dev_60m"] > 0.50
    # Check rate of change captured the jump
    assert feat_df.iloc[-1]["current_mean_roc"] > 2.0


def test_psi_drift_detection_threshold():
    """Verify PSI is near 0 for matching distributions and > 0.2 for shifted distributions."""
    rng = np.random.default_rng(42)
    train_df = pd.DataFrame({"voltage_mean": rng.normal(230.0, 1.5, size=1000)})
    ref_bins = build_reference_psi_bins(train_df, ["voltage_mean"], num_bins=10)

    # Matching distribution -> low PSI
    same_vals = rng.normal(230.0, 1.5, size=300)
    psi_same = compute_psi(
        ref_bins["voltage_mean"]["bin_edges"],
        ref_bins["voltage_mean"]["proportions"],
        same_vals,
    )
    assert psi_same < 0.1

    # Shifted distribution -> high PSI > 0.2
    shifted_vals = rng.normal(218.0, 2.0, size=300)
    psi_shifted = compute_psi(
        ref_bins["voltage_mean"]["bin_edges"],
        ref_bins["voltage_mean"]["proportions"],
        shifted_vals,
    )
    assert psi_shifted > 0.2


def test_explainability_top_3_plain_language():
    """Verify explain_reading returns top 3 contributing features in plain language."""
    rows = _make_sample_readings(n=10)
    rows[-1]["current_b"] = 22.5  # +50% on Phase B
    df = engineer_features(pd.DataFrame(rows))
    last_row = df.iloc[-1]

    explanations = explain_reading(last_row, {"current_b_rel_dev_60m": 4.5, "current_imbalance_nema": 3.8})
    assert len(explanations) == 3
    top_features = [e["feature"] for e in explanations]
    assert "current_b" in top_features
    assert "60-minute baseline" in explanations[0]["description"] or "balanced 3-phase baseline" in explanations[0]["description"]


def test_fastapi_endpoints_health_model_info_and_score():
    """Verify /health, /model/info, and /score endpoints end to end against trained artifacts."""
    artifacts_latest = ML_DIR / "artifacts" / "latest.txt"
    if not artifacts_latest.exists():
        pytest.skip("Trained artifacts not found; run train.py first.")

    with TestClient(app) as client:
        # 1. GET /health
        health_resp = client.get("/health")
        assert health_resp.status_code == 200
        health_data = health_resp.json()
        assert health_data["status"] == "ok"
        assert health_data["model_loaded"] is True
        assert "drift_warning" in health_data

        # 2. GET /model/info
        info_resp = client.get("/model/info")
        assert info_resp.status_code == 200
        info_data = info_resp.json()
        assert info_data["version"] == artifacts_latest.read_text(encoding="utf-8").strip()
        assert "metrics" in info_data
        assert "drift" in info_data

        # 3. POST /score with normal baseline + injected power theft + voltage sag
        readings = _make_sample_readings(n=8, meter_id="MTR-TEST-01", base_current=18.0)
        # Inject power theft on reading 6 (sudden 50% current drop, normal 230V)
        readings[6]["current_a"] = 8.5
        readings[6]["current_b"] = 8.6
        readings[6]["current_c"] = 8.4
        # Inject voltage sag on reading 7 (< 207V)
        readings[7]["voltage_a"] = 188.0
        readings[7]["voltage_b"] = 189.5
        readings[7]["voltage_c"] = 190.0

        score_resp = client.post("/score", json={"readings": readings})
        assert score_resp.status_code == 200
        score_data = score_resp.json()
        assert score_data["count"] == 8
        assert score_data["anomalies_detected"] >= 2

        theft_res = score_data["results"][6]
        assert theft_res["is_anomaly"] is True
        assert theft_res["predicted_type"] == "power_theft"
        assert len(theft_res["explanations"]) == 3

        sag_res = score_data["results"][7]
        assert sag_res["is_anomaly"] is True
        assert sag_res["predicted_type"] == "voltage_sag"
        assert len(sag_res["explanations"]) == 3


def test_model_info_matches_evaluation_doc():
    """Verify /model/info held-out metrics match docs/model-evaluation.md exactly."""
    import re

    eval_doc = ML_DIR.parent / "docs" / "model-evaluation.md"
    if not eval_doc.exists():
        pytest.skip("docs/model-evaluation.md not found.")

    text = eval_doc.read_text(encoding="utf-8")
    with TestClient(app) as client:
        resp = client.get("/model/info")
        assert resp.status_code == 200
        metrics = resp.json()["metrics"]

    overall = metrics["overall"]
    for label, key in [("Precision", "precision"), ("Recall", "recall"), ("F1 Score", "f1"), ("False Positive Rate (FPR)", "fpr")]:
        m = re.search(rf"\|\s*{re.escape(label)}\s*\|\s*([0-9.]+)\s*\|", text)
        assert m is not None, f"Missing {label} in docs/model-evaluation.md"
        assert float(m.group(1)) == pytest.approx(overall[key], abs=1e-4)

    for fault_type, vals in metrics["per_fault"].items():
        m = re.search(
            rf"\|\s*`{re.escape(fault_type)}`\s*\|\s*(\d+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|",
            text,
        )
        assert m is not None, f"Missing per-fault row for {fault_type} in docs/model-evaluation.md"
        assert int(m.group(1)) == vals["support"]
        assert float(m.group(2)) == pytest.approx(vals["precision"], abs=1e-4)
        assert float(m.group(3)) == pytest.approx(vals["recall"], abs=1e-4)
        assert float(m.group(4)) == pytest.approx(vals["f1"], abs=1e-4)
        assert float(m.group(5)) == pytest.approx(vals["fpr"], abs=1e-4)
