"""ML Models, PyTorch LSTM Autoencoder, Hard Rule Layer, and Ensemble Scoring."""

from typing import Any, Dict, List, Optional, Tuple
import numpy as np
import pandas as pd
import torch
import torch.nn as nn


class LSTMAutoencoder(nn.Module):
    """Sequence-to-sequence LSTM Autoencoder for multivariate smart-meter time series."""

    def __init__(self, input_dim: int, hidden_dim: int = 24, latent_dim: int = 12) -> None:
        super().__init__()
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.latent_dim = latent_dim

        self.encoder = nn.LSTM(input_dim, hidden_dim, batch_first=True)
        self.to_latent = nn.Linear(hidden_dim, latent_dim)
        self.from_latent = nn.Linear(latent_dim, hidden_dim)
        self.decoder = nn.LSTM(hidden_dim, hidden_dim, batch_first=True)
        self.output_layer = nn.Linear(hidden_dim, input_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, seq_len, input_dim)
        _, (h_n, _) = self.encoder(x)
        latent = torch.relu(self.to_latent(h_n[-1]))
        dec_in = torch.relu(self.from_latent(latent)).unsqueeze(1).repeat(1, x.size(1), 1)
        dec_out, _ = self.decoder(dec_in)
        return self.output_layer(dec_out)


def build_sequences(
    X: np.ndarray,
    meter_ids: np.ndarray,
    seq_len: int = 60,
    labels: Optional[np.ndarray] = None,
    normal_only: bool = False,
    tail: int = 5,
    min_normal_frac: float = 0.8,
) -> Tuple[np.ndarray, np.ndarray]:
    """Create sliding windows of length `seq_len` per meter.

    If `normal_only` is True, only windows whose last `tail` steps are 'normal' and that are
    at least `min_normal_frac` normal overall are kept. (Requiring ALL 60 steps to be normal
    leaves almost no windows when ~20% of readings are faulty, and the resulting model is
    calibrated on unrepresentatively clean windows.)
    Returns (sequences, target_indices) where target_indices maps each sequence back to X.
    """
    sequences: List[np.ndarray] = []
    target_indices: List[int] = []

    unique_meters = pd.unique(meter_ids)
    for m_id in unique_meters:
        idx = np.where(meter_ids == m_id)[0]
        if len(idx) < seq_len:
            continue
        for end_pos in range(seq_len - 1, len(idx)):
            win_idx = idx[end_pos - seq_len + 1 : end_pos + 1]
            if normal_only and labels is not None:
                is_normal = labels[win_idx] == "normal"
                if not np.all(is_normal[-tail:]) or is_normal.mean() < min_normal_frac:
                    continue
            sequences.append(X[win_idx])
            target_indices.append(int(win_idx[-1]))

    if not sequences:
        return np.empty((0, seq_len, X.shape[1]), dtype=np.float32), np.empty((0,), dtype=int)

    return np.array(sequences, dtype=np.float32), np.array(target_indices, dtype=int)


def compute_lstm_reconstruction_errors(
    model: LSTMAutoencoder,
    sequences: np.ndarray,
    batch_size: int = 256,
    device: str = "cpu",
    tail: int = 5,
) -> np.ndarray:
    """Per-sequence MSE over the LAST `tail` steps only.

    The window gives temporal context, but the score must describe the reading being scored;
    averaging over all 60 steps made one old fault taint the next ~60 readings.
    """
    if len(sequences) == 0:
        return np.empty((0,), dtype=np.float32)

    model.eval()
    errors: List[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, len(sequences), batch_size):
            batch_np = sequences[start : start + batch_size]
            batch_t = torch.from_numpy(batch_np).to(device)
            recon = model(batch_t)
            mse = torch.mean((recon[:, -tail:] - batch_t[:, -tail:]) ** 2, dim=(1, 2))
            errors.append(mse.cpu().numpy())
    return np.concatenate(errors, axis=0)


def evaluate_hard_rules(row: pd.Series, rules_cfg: Dict[str, Any]) -> Tuple[bool, Optional[str], float]:
    """Evaluate deterministic electrical safety and theft rules.

    Returns (triggered, fault_type_hint, rule_score_boost).
    """
    v_min = float(rules_cfg.get("voltage_min_v", 207.0))
    v_max = float(rules_cfg.get("voltage_max_v", 253.0))
    nema_thresh = float(rules_cfg.get("nema_imbalance_threshold", 0.10))
    overcurrent_thresh = float(rules_cfg.get("overcurrent_ratio_threshold", 1.75))
    pf_min = float(rules_cfg.get("power_factor_min", 0.78))
    theft_drop = float(rules_cfg.get("power_theft_drop_ratio", 0.30))
    theft_v_min = float(rules_cfg.get("power_theft_voltage_normal_min", 215.0))
    theft_v_max = float(rules_cfg.get("power_theft_voltage_normal_max", 245.0))

    voltages = [float(row["voltage_a"]), float(row["voltage_b"]), float(row["voltage_c"])]
    v_mean = float(row.get("voltage_mean", sum(voltages) / 3.0))
    pf = float(row["power_factor"])
    c_imb = float(row.get("current_imbalance_nema", 0.0))
    c_mean_rel = float(row.get("current_mean_rel_dev_60m", 0.0))
    load_vs_profile = float(row.get("load_vs_profile", 0.0))
    theft_profile_drop = float(rules_cfg.get("power_theft_profile_drop_ratio", 0.28))
    c_phase_rels = [
        float(row.get("current_a_rel_dev_60m", 0.0)),
        float(row.get("current_b_rel_dev_60m", 0.0)),
        float(row.get("current_c_rel_dev_60m", 0.0)),
    ]

    # 1. Voltage sag or swell outside 207-253V (EN 50160 +/-10% around 230V)
    if min(voltages) < v_min:
        return True, "voltage_sag", 0.92
    if max(voltages) > v_max:
        return True, "voltage_swell", 0.92

    # 2. Overcurrent spike
    has_profile = load_vs_profile != 0.0
    # Profile-based when available: the evening ramp is a big move vs. the 60m baseline but
    # not vs. the typical load for that time of day, so this avoids ramp false alarms.
    surge = load_vs_profile if has_profile else max(c_mean_rel, max(c_phase_rels))
    if surge >= (overcurrent_thresh - 1.0):
        # Distinguish 3-phase overcurrent from single-phase imbalance
        if c_imb < nema_thresh:
            return True, "overcurrent_spike", 0.90

    # 3. Harmonic distortion (severe power factor drop)
    if pf < pf_min:
        return True, "harmonic_distortion", 0.88

    # 4. Phase imbalance (NEMA index)
    if c_imb >= nema_thresh:
        return True, "phase_imbalance", 0.86

    # 5. Power theft signature: sudden >=30% load drop while voltage stays normal
    # Primary: load far below this meter's typical level for the time of day.
    # Fallback (no profile, e.g. brand-new meter): sudden drop vs. 60-minute baseline.
    voltage_normal = theft_v_min <= v_mean <= theft_v_max
    if voltage_normal and (
        load_vs_profile <= -theft_profile_drop if has_profile else c_mean_rel <= -theft_drop
    ):
        return True, "power_theft", 0.89

    return False, None, 0.0


def classify_anomaly_type(row: pd.Series, rule_hint: Optional[str]) -> str:
    """Infer the most likely fault type when an anomaly is detected."""
    if rule_hint is not None:
        return rule_hint

    voltages = [float(row["voltage_a"]), float(row["voltage_b"]), float(row["voltage_c"])]
    pf = float(row["power_factor"])
    c_imb = float(row.get("current_imbalance_nema", 0.0))
    c_mean_rel = float(row.get("current_mean_rel_dev_60m", 0.0))
    load_vs_profile = float(row.get("load_vs_profile", 0.0))

    if min(voltages) < 212.0:
        return "voltage_sag"
    if max(voltages) > 248.0:
        return "voltage_swell"
    if pf < 0.85:
        return "harmonic_distortion"
    if c_imb >= 0.08:
        return "phase_imbalance"
    if (load_vs_profile if load_vs_profile != 0.0 else c_mean_rel) >= 0.75:
        return "overcurrent_spike"
    if load_vs_profile <= -0.25 or (load_vs_profile == 0.0 and c_mean_rel <= -0.25):
        return "power_theft"
    return "anomaly"


def score_to_severity(score: float, fault_type: str) -> str:
    """Map normalized ensemble score [0, 1] and fault type to alert severity."""
    if fault_type in ("overcurrent_spike", "power_theft") and score >= 0.75:
        return "critical"
    if score >= 0.85:
        return "critical"
    if score >= 0.65:
        return "high"
    if score >= 0.50:
        return "medium"
    return "low"
