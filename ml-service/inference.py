"""Shared Inference, Ensemble Scoring, Explainability, and Drift Monitoring Engine."""

from collections import deque
import json
from pathlib import Path
import pickle
import sys
from typing import Any, Deque, Dict, List, Optional

import numpy as np
import pandas as pd
import torch
import yaml

ML_DIR = Path(__file__).resolve().parent
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from explainability import explain_reading
from features import FEATURE_COLUMNS, compute_psi, engineer_features
from models import (
    LSTMAutoencoder,
    classify_anomaly_type,
    compute_lstm_reconstruction_errors,
    evaluate_hard_rules,
    score_to_severity,
)


class GridSenseScorer:
    """Loads versioned GridSense ML artifacts and scores batches of meter readings."""

    def __init__(self, artifacts_root: Path, config_path: Path, version: Optional[str] = None) -> None:
        self.artifacts_root = Path(artifacts_root)
        self.config_path = Path(config_path)

        with self.config_path.open("r", encoding="utf-8") as f:
            self.cfg: Dict[str, Any] = yaml.safe_load(f)

        if version is None:
            latest_file = self.artifacts_root / "latest.txt"
            if not latest_file.exists():
                raise FileNotFoundError(f"No latest.txt found in {self.artifacts_root}. Run train.py first.")
            version = latest_file.read_text(encoding="utf-8").strip()

        self.version = version
        self.version_dir = self.artifacts_root / version

        with (self.version_dir / "metadata.json").open("r", encoding="utf-8") as f:
            self.metadata: Dict[str, Any] = json.load(f)

        with (self.version_dir / "scaler.pkl").open("rb") as f:
            self.scaler = pickle.load(f)

        with (self.version_dir / "isolation_forest.pkl").open("rb") as f:
            self.iso_forest = pickle.load(f)

        ckpt = torch.load(self.version_dir / "lstm_autoencoder.pt", map_location="cpu", weights_only=True)
        self.seq_len = int(ckpt["seq_len"])
        self.lstm_model = LSTMAutoencoder(
            input_dim=int(ckpt["input_dim"]),
            hidden_dim=int(ckpt["hidden_dim"]),
            latent_dim=int(ckpt["latent_dim"]),
        )
        self.lstm_model.load_state_dict(ckpt["state_dict"])
        self.lstm_model.eval()

        self.load_profile: Dict[str, Dict[str, float]] = self.metadata.get("load_profile", {})

        # Per-meter rolling history buffer for real-time 60m features & 60-step LSTM windows
        self.meter_history: Dict[str, Deque[Dict[str, Any]]] = {}
        self.max_history_per_meter = max(self.seq_len + 10, 80)

        # Rolling feature buffer for PSI drift detection
        drift_win = int(self.cfg["drift"].get("recent_window_size", 500))
        self.recent_drift_buffer: Deque[Dict[str, float]] = deque(maxlen=drift_win)

    def _normalize_if_score(self, raw_if: np.ndarray) -> np.ndarray:
        bounds = self.metadata["isolation_forest_bounds"]
        low, thresh = float(bounds["p5"]), float(bounds["p99"])
        denom = max((thresh - low) / 0.65, 1e-6)
        return np.clip((raw_if - low) / denom, 0.0, 1.0)

    def _normalize_lstm_score(self, mse_errors: np.ndarray) -> np.ndarray:
        low = float(self.metadata.get("lstm_p5", 0.0))
        thresh = float(self.metadata.get("lstm_threshold", 1.0))
        # Map validation percentile threshold to 0.65 normalized score
        denom = max((thresh - low) / 0.65, 1e-6)
        return np.clip((mse_errors - low) / denom, 0.0, 1.0)

    def score_engineered_dataframe(
        self,
        feat_df: pd.DataFrame,
        update_drift: bool = False,
    ) -> List[Dict[str, Any]]:
        """Score an already-feature-engineered DataFrame (used by evaluation & real-time API)."""
        if feat_df.empty:
            return []

        X_scaled = self.scaler.transform(feat_df[FEATURE_COLUMNS].to_numpy(dtype=np.float32))

        # 1. Isolation Forest point anomaly score
        raw_if = -self.iso_forest.decision_function(X_scaled)
        if_scores = self._normalize_if_score(raw_if)

        # 2. LSTM Autoencoder sequence score (pad short meter histories at the front if needed)
        lstm_seqs = np.zeros((len(feat_df), self.seq_len, X_scaled.shape[1]), dtype=np.float32)
        meter_ids = feat_df["meter_id"].to_numpy()
        meter_positions: Dict[str, List[int]] = {}
        for idx, m_id in enumerate(meter_ids):
            meter_positions.setdefault(str(m_id), []).append(idx)

        for _, positions in meter_positions.items():
            for pos_i, global_idx in enumerate(positions):
                start_pos = max(0, pos_i - self.seq_len + 1)
                slice_indices = positions[start_pos : pos_i + 1]
                seq_data = X_scaled[slice_indices]
                if len(seq_data) < self.seq_len:
                    pad_count = self.seq_len - len(seq_data)
                    pad_block = np.repeat(seq_data[:1], pad_count, axis=0)
                    seq_data = np.vstack([pad_block, seq_data])
                lstm_seqs[global_idx] = seq_data

        raw_lstm = compute_lstm_reconstruction_errors(self.lstm_model, lstm_seqs, batch_size=256)
        lstm_scores = self._normalize_lstm_score(raw_lstm)

        # 3. Combine with YAML ensemble weights + Hard Rule Layer
        ens_cfg = self.cfg["ensemble"]
        w_if = float(ens_cfg.get("isolation_forest_weight", 0.55))
        w_lstm = float(ens_cfg.get("lstm_autoencoder_weight", 0.45))
        anom_thresh = float(ens_cfg.get("anomaly_threshold", 0.55))
        rules_cfg = self.cfg["hard_rules"]

        scaler_mean = np.array(self.metadata["scaler_mean"], dtype=float)
        scaler_scale = np.array(self.metadata["scaler_scale"], dtype=float)

        results: List[Dict[str, Any]] = []
        psi_cols = list(self.metadata.get("psi_reference", {}).keys())

        for i in range(len(feat_df)):
            row = feat_df.iloc[i]
            base_score = float(w_if * if_scores[i] + w_lstm * lstm_scores[i])
            rule_triggered, rule_hint, rule_boost = evaluate_hard_rules(row, rules_cfg)

            final_score = round(max(base_score, rule_boost) if rule_triggered else base_score, 4)
            is_anomaly = bool(final_score >= anom_thresh or rule_triggered)
            predicted_type = classify_anomaly_type(row, rule_hint) if is_anomaly else "normal"
            severity = score_to_severity(final_score, predicted_type) if is_anomaly else "normal"

            # Compute per-feature z-scores for explainability
            z_vec = (feat_df[FEATURE_COLUMNS].iloc[i].to_numpy(dtype=float) - scaler_mean) / np.maximum(scaler_scale, 1e-6)
            z_map = {col: float(z_vec[idx]) for idx, col in enumerate(FEATURE_COLUMNS)}
            explanations = explain_reading(row, z_map)

            if update_drift:
                self.recent_drift_buffer.append({col: float(row[col]) for col in psi_cols if col in row})

            results.append(
                {
                    "timestamp": str(row["timestamp"]),
                    "meter_id": str(row["meter_id"]),
                    "is_anomaly": is_anomaly,
                    "anomaly_score": final_score,
                    "isolation_forest_score": round(float(if_scores[i]), 4),
                    "lstm_score": round(float(lstm_scores[i]), 4),
                    "rule_triggered": rule_triggered,
                    "predicted_type": predicted_type,
                    "severity": severity,
                    "explanations": explanations,
                }
            )

        return results

    def score_batch(self, readings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Score an incoming real-time batch using per-meter rolling history buffers."""
        if not readings:
            return []

        incoming_keys = set()
        combined_rows: List[Dict[str, Any]] = []
        meters_in_batch = sorted({str(r["meter_id"]) for r in readings})

        for r in readings:
            m_id = str(r["meter_id"])
            incoming_keys.add((m_id, str(r["timestamp"])))
            hist = self.meter_history.setdefault(m_id, deque(maxlen=self.max_history_per_meter))
            hist.append(r)

        for m_id in meters_in_batch:
            combined_rows.extend(list(self.meter_history[m_id]))

        df_all = pd.DataFrame(combined_rows)
        feat_df = engineer_features(df_all, load_profile=self.load_profile)
        all_scored = self.score_engineered_dataframe(feat_df, update_drift=True)

        # Return only the scored results corresponding to the newly submitted readings
        scored_lookup = {(item["meter_id"], item["timestamp"]): item for item in all_scored}
        return [scored_lookup[(str(r["meter_id"]), str(r["timestamp"]))] for r in readings]

    def get_drift_status(self) -> Dict[str, Any]:
        """Compute PSI across monitored features on recent readings vs. training baseline."""
        psi_ref = self.metadata.get("psi_reference", {})
        threshold = float(self.cfg["drift"].get("psi_warning_threshold", 0.20))

        if len(self.recent_drift_buffer) < 20:
            return {
                "sample_count": len(self.recent_drift_buffer),
                "psi_threshold": threshold,
                "max_psi": 0.0,
                "drift_warning": False,
                "feature_psi": {col: 0.0 for col in psi_ref},
            }

        recent_df = pd.DataFrame(list(self.recent_drift_buffer))
        feature_psi: Dict[str, float] = {}
        for col, ref in psi_ref.items():
            if col in recent_df.columns:
                vals = recent_df[col].dropna().to_numpy(dtype=float)
                feature_psi[col] = compute_psi(ref["bin_edges"], ref["proportions"], vals)

        max_psi = max(feature_psi.values()) if feature_psi else 0.0
        return {
            "sample_count": len(self.recent_drift_buffer),
            "psi_threshold": threshold,
            "max_psi": round(float(max_psi), 4),
            "drift_warning": bool(max_psi > threshold),
            "feature_psi": feature_psi,
        }
