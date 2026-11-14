"""Training pipeline for GridSense ML Service.

Performs:
1. Feature engineering on historical simulator CSV data
2. Strict time-based train / validation / test split (60% / 20% / 20%)
3. Isolation Forest training on normal data only
4. PyTorch LSTM Autoencoder training on sliding windows of 60 normal readings
5. Validation percentile threshold calibration & PSI reference distribution extraction
6. Versioned artifact persistence to /ml-service/artifacts/<version>/
"""

import argparse
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import pickle
import sys
from typing import Any, Dict, Tuple

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import yaml

ML_DIR = Path(__file__).resolve().parent
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from features import FEATURE_COLUMNS, build_load_profile, build_reference_psi_bins, engineer_features
from models import LSTMAutoencoder, build_sequences, compute_lstm_reconstruction_errors

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ml_service.train")

PSI_MONITORED_FEATURES = [
    "voltage_mean",
    "current_mean",
    "power_factor",
    "frequency",
    "current_imbalance_nema",
    "current_mean_rel_dev_60m",
]


def time_based_split(df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Split DataFrame strictly by timestamp (60% train, 20% val, 20% test)."""
    df_sorted = df.copy()
    df_sorted["_ts"] = pd.to_datetime(df_sorted["timestamp"], utc=True)
    unique_ts = np.sort(df_sorted["_ts"].unique())

    n_ts = len(unique_ts)
    train_end_ts = unique_ts[int(n_ts * 0.60)]
    val_end_ts = unique_ts[int(n_ts * 0.80)]

    train_df = df_sorted[df_sorted["_ts"] <= train_end_ts].drop(columns=["_ts"]).reset_index(drop=True)
    val_df = df_sorted[
        (df_sorted["_ts"] > train_end_ts) & (df_sorted["_ts"] <= val_end_ts)
    ].drop(columns=["_ts"]).reset_index(drop=True)
    test_df = df_sorted[df_sorted["_ts"] > val_end_ts].drop(columns=["_ts"]).reset_index(drop=True)
    return train_df, val_df, test_df


def train_models(
    data_csv: Path,
    config_path: Path,
    artifacts_root: Path,
    version: str,
) -> Path:
    """Train Isolation Forest + LSTM Autoencoder and persist versioned artifacts."""
    with config_path.open("r", encoding="utf-8") as f:
        cfg: Dict[str, Any] = yaml.safe_load(f)

    logger.info("Loading dataset from %s", data_csv)
    raw_df = pd.read_csv(data_csv)
    logger.info("Engineering features for %d rows...", len(raw_df))
    # Time-of-day load profile from NORMAL rows of the TRAIN period only (no leakage).
    raw_train, _, _ = time_based_split(raw_df)
    load_profile = build_load_profile(raw_train[raw_train["fault_label"] == "normal"])
    feat_df = engineer_features(raw_df, load_profile=load_profile)

    train_df, val_df, test_df = time_based_split(feat_df)
    logger.info(
        "Time-based split complete: train=%d, val=%d, test=%d",
        len(train_df),
        len(val_df),
        len(test_df),
    )

    # Filter normal-only rows for unsupervised training
    train_normal = train_df[train_df["fault_label"] == "normal"].reset_index(drop=True)
    val_normal = val_df[val_df["fault_label"] == "normal"].reset_index(drop=True)

    scaler = StandardScaler()
    X_train_norm = scaler.fit_transform(train_normal[FEATURE_COLUMNS].to_numpy(dtype=np.float32))
    X_val_norm = scaler.transform(val_normal[FEATURE_COLUMNS].to_numpy(dtype=np.float32))

    # 1. Train Isolation Forest on normal data only
    if_cfg = cfg["isolation_forest"]
    iso_forest = IsolationForest(
        n_estimators=int(if_cfg.get("n_estimators", 120)),
        contamination=float(if_cfg.get("contamination", 0.03)),
        random_state=int(if_cfg.get("random_state", 42)),
        n_jobs=-1,
    )
    iso_forest.fit(X_train_norm)

    # decision_function: higher = more normal, lower = more anomalous. Invert to anomaly score.
    val_if_raw = -iso_forest.decision_function(X_val_norm)
    if_p5 = float(np.percentile(val_if_raw, 5))
    if_p98 = float(np.percentile(val_if_raw, float(cfg["lstm"].get("validation_percentile", 98.0))))
    if if_p98 <= if_p5:
        if_p98 = if_p5 + 1.0

    # 2. Train PyTorch LSTM Autoencoder on 60-step normal sliding windows
    lstm_cfg = cfg["lstm"]
    seq_len = int(lstm_cfg.get("sequence_length", 60))
    hidden_dim = int(lstm_cfg.get("hidden_dim", 24))
    latent_dim = int(lstm_cfg.get("latent_dim", 12))
    epochs = int(lstm_cfg.get("epochs", 8))
    batch_size = int(lstm_cfg.get("batch_size", 256))
    lr = float(lstm_cfg.get("learning_rate", 0.003))
    val_percentile = float(lstm_cfg.get("validation_percentile", 96.0))

    X_train_all = scaler.transform(train_df[FEATURE_COLUMNS].to_numpy(dtype=np.float32))
    train_seqs, _ = build_sequences(
        X_train_all,
        train_df["meter_id"].to_numpy(),
        seq_len=seq_len,
        labels=train_df["fault_label"].to_numpy(),
        normal_only=True,
    )
    logger.info("Built %d normal LSTM training sequences (seq_len=%d)", len(train_seqs), seq_len)

    device = "cpu"
    torch.manual_seed(42)
    lstm_model = LSTMAutoencoder(
        input_dim=len(FEATURE_COLUMNS),
        hidden_dim=hidden_dim,
        latent_dim=latent_dim,
    ).to(device)

    optimizer = torch.optim.Adam(lstm_model.parameters(), lr=lr)
    criterion = nn.MSELoss()

    dataset = TensorDataset(torch.from_numpy(train_seqs))
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    lstm_model.train()
    for epoch in range(1, epochs + 1):
        epoch_loss = 0.0
        for (batch_x,) in loader:
            batch_x = batch_x.to(device)
            optimizer.zero_grad()
            recon = lstm_model(batch_x)
            loss = criterion(recon, batch_x)
            loss.backward()
            optimizer.step()
            epoch_loss += float(loss.item()) * len(batch_x)
        avg_loss = epoch_loss / max(len(train_seqs), 1)
        logger.info("LSTM Epoch %d/%d - MSE Loss: %.5f", epoch, epochs, avg_loss)

    # Calibrate LSTM threshold from validation percentile on normal sequences
    X_val_all = scaler.transform(val_df[FEATURE_COLUMNS].to_numpy(dtype=np.float32))
    val_seqs, _ = build_sequences(
        X_val_all,
        val_df["meter_id"].to_numpy(),
        seq_len=seq_len,
        labels=val_df["fault_label"].to_numpy(),
        normal_only=True,
    )
    val_errors = compute_lstm_reconstruction_errors(lstm_model, val_seqs, batch_size=batch_size, device=device)
    lstm_threshold = float(np.percentile(val_errors, val_percentile)) if len(val_errors) > 0 else 1.0
    lstm_p5 = float(np.percentile(val_errors, 5)) if len(val_errors) > 0 else 0.0
    logger.info("Calibrated LSTM threshold (p%.1f): %.5f", val_percentile, lstm_threshold)

    # 3. Build reference PSI distributions on normal training features
    psi_bins = build_reference_psi_bins(
        train_normal,
        monitored_cols=PSI_MONITORED_FEATURES,
        num_bins=int(cfg["drift"].get("num_bins", 10)),
    )

    # 4. Save versioned artifacts
    version_dir = artifacts_root / version
    version_dir.mkdir(parents=True, exist_ok=True)

    with (version_dir / "scaler.pkl").open("wb") as f:
        pickle.dump(scaler, f)
    with (version_dir / "isolation_forest.pkl").open("wb") as f:
        pickle.dump(iso_forest, f)

    torch.save(
        {
            "state_dict": lstm_model.state_dict(),
            "input_dim": len(FEATURE_COLUMNS),
            "hidden_dim": hidden_dim,
            "latent_dim": latent_dim,
            "seq_len": seq_len,
        },
        version_dir / "lstm_autoencoder.pt",
    )

    metadata: Dict[str, Any] = {
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "feature_columns": FEATURE_COLUMNS,
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "isolation_forest_bounds": {"p5": if_p5, "p99": if_p98},
        "lstm_threshold": lstm_threshold,
        "lstm_p5": lstm_p5,
        "seq_len": seq_len,
        "load_profile": load_profile,
        "psi_reference": psi_bins,
        "split_counts": {
            "train": int(len(train_df)),
            "validation": int(len(val_df)),
            "test": int(len(test_df)),
        },
        "metrics": {},
    }

    with (version_dir / "metadata.json").open("w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    (artifacts_root / "latest.txt").write_text(version, encoding="utf-8")
    logger.info("Saved versioned ML artifacts to %s", version_dir)
    return version_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train GridSense ML Anomaly Detection Ensemble")
    parser.add_argument(
        "--data",
        type=str,
        default="simulator/data/historical_readings_30d.csv",
        help="Path to historical simulator CSV",
    )
    parser.add_argument(
        "--config",
        type=str,
        default="ml-service/config.yaml",
        help="Path to ML service YAML config",
    )
    parser.add_argument(
        "--artifacts",
        type=str,
        default="ml-service/artifacts",
        help="Root directory for versioned artifacts",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="v1.0.0",
        help="Model version tag (e.g., v1.0.0)",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    train_models(
        data_csv=Path(args.data),
        config_path=Path(args.config),
        artifacts_root=Path(args.artifacts),
        version=args.version,
    )
