"""FastAPI ML Service for GridSense Real-Time Anomaly & Power-Theft Detection."""

from contextlib import asynccontextmanager
import os
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ML_DIR = Path(__file__).resolve().parent
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from inference import GridSenseScorer


class MeterReadingIn(BaseModel):
    timestamp: str
    meter_id: str
    voltage_a: float
    voltage_b: float
    voltage_c: float
    current_a: float
    current_b: float
    current_c: float
    power_factor: float = Field(..., ge=0.0, le=1.0)
    frequency: float
    active_energy_kwh: float = 0.0


class ScoreBatchRequest(BaseModel):
    readings: List[MeterReadingIn]


class ExplanationItem(BaseModel):
    feature: str
    deviation_pct: float
    z_score: float
    description: str


class ScoredReadingOut(BaseModel):
    timestamp: str
    meter_id: str
    is_anomaly: bool
    anomaly_score: float
    isolation_forest_score: float
    lstm_score: float
    rule_triggered: bool
    predicted_type: str
    severity: str
    explanations: List[ExplanationItem]


class ScoreBatchResponse(BaseModel):
    model_version: str
    count: int
    anomalies_detected: int
    results: List[ScoredReadingOut]


def create_scorer() -> GridSenseScorer:
    artifacts_root = Path(os.getenv("ML_ARTIFACTS_DIR", str(ML_DIR / "artifacts")))
    config_path = Path(os.getenv("ML_CONFIG_PATH", str(ML_DIR / "config.yaml")))
    version = os.getenv("ML_MODEL_VERSION") or None
    return GridSenseScorer(artifacts_root=artifacts_root, config_path=config_path, version=version)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.scorer = create_scorer()
    yield


app = FastAPI(
    title="GridSense ML Service",
    description="Real-time electrical fault and power-theft detection using Isolation Forest + LSTM Autoencoder + Hard Rules",
    version="1.0.0",
    lifespan=lifespan,
)


def _get_scorer() -> GridSenseScorer:
    scorer: Optional[GridSenseScorer] = getattr(app.state, "scorer", None)
    if scorer is None:
        scorer = create_scorer()
        app.state.scorer = scorer
    return scorer


@app.get("/health")
def health() -> Dict[str, Any]:
    """Return service health, model readiness, and PSI drift warning flag."""
    try:
        scorer = _get_scorer()
        drift = scorer.get_drift_status()
        return {
            "status": "ok",
            "model_loaded": True,
            "model_version": scorer.version,
            "drift_warning": drift["drift_warning"],
            "max_psi": drift["max_psi"],
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Model unavailable: {exc}") from exc


@app.get("/model/info")
def model_info() -> Dict[str, Any]:
    """Return active model version, training timestamp, evaluation metrics, and drift details."""
    scorer = _get_scorer()
    drift = scorer.get_drift_status()
    return {
        "version": scorer.version,
        "trained_at": scorer.metadata.get("trained_at"),
        "feature_count": len(scorer.metadata.get("feature_columns", [])),
        "sequence_length": scorer.seq_len,
        "lstm_threshold": scorer.metadata.get("lstm_threshold"),
        "ensemble_weights": scorer.cfg.get("ensemble", {}),
        "metrics": scorer.metadata.get("metrics", {}),
        "drift": drift,
    }


@app.post("/score", response_model=ScoreBatchResponse)
def score_readings(payload: ScoreBatchRequest) -> ScoreBatchResponse:
    """Score a batch of smart-meter readings and return anomaly flags, scores, and explanations."""
    scorer = _get_scorer()
    raw_dicts = [r.model_dump() for r in payload.readings]
    results = scorer.score_batch(raw_dicts)
    anomalies_count = sum(1 for r in results if r["is_anomaly"])
    return ScoreBatchResponse(
        model_version=scorer.version,
        count=len(results),
        anomalies_detected=anomalies_count,
        results=[ScoredReadingOut(**r) for r in results],
    )
