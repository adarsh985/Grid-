"""Feature engineering and Population Stability Index (PSI) drift computation for GridSense.

Computes:
- Rolling mean and std over 5, 15, and 60 minute windows per meter
- Per-phase voltage and current ratios (A/B, B/C, C/A)
- NEMA-style phase imbalance index: max(|X_phase - X_mean|) / X_mean for both voltage and current
- Power factor deviation from nominal (0.95) and rolling baseline
- First-difference rate of change for currents, voltages, and power factor
"""

from typing import Dict, List, Optional, Tuple
import numpy as np
import pandas as pd

NOMINAL_POWER_FACTOR = 0.95
NOMINAL_VOLTAGE = 230.0
EPS = 1e-6

FEATURE_COLUMNS: List[str] = [
    # Raw signals
    "voltage_a",
    "voltage_b",
    "voltage_c",
    "current_a",
    "current_b",
    "current_c",
    "power_factor",
    "frequency",
    # Aggregates
    "voltage_mean",
    "current_mean",
    # Per-phase ratios
    "voltage_ratio_ab",
    "voltage_ratio_bc",
    "voltage_ratio_ca",
    "current_ratio_ab",
    "current_ratio_bc",
    "current_ratio_ca",
    # NEMA-style phase imbalance indices
    "voltage_imbalance_nema",
    "current_imbalance_nema",
    # Power factor deviation
    "pf_deviation_nominal",
    "pf_deviation_rolling_60m",
    # Rolling means & stds over 5, 15, 60m windows
    "voltage_mean_roll_mean_5m",
    "voltage_mean_roll_std_5m",
    "voltage_mean_roll_mean_15m",
    "voltage_mean_roll_std_15m",
    "voltage_mean_roll_mean_60m",
    "voltage_mean_roll_std_60m",
    "current_mean_roll_mean_5m",
    "current_mean_roll_std_5m",
    "current_mean_roll_mean_15m",
    "current_mean_roll_std_15m",
    "current_mean_roll_mean_60m",
    "current_mean_roll_std_60m",
    # Relative deviations from 60m rolling baseline (crucial for theft/spike/imbalance explainability)
    "current_a_rel_dev_60m",
    "current_b_rel_dev_60m",
    "current_c_rel_dev_60m",
    "current_mean_rel_dev_60m",
    "voltage_a_rel_dev_60m",
    "voltage_b_rel_dev_60m",
    "voltage_c_rel_dev_60m",
    # Rate of change (step-over-step delta)
    "current_mean_roc",
    "voltage_mean_roc",
    "pf_roc",
    # Load relative to this meter's typical level for the same 15-minute time-of-day slot.
    # Unlike the 60m baseline it does not get dragged down by an ongoing theft episode,
    # and it is not fooled by the normal evening ramp.
    "load_vs_profile",
]


def time_slot(ts: pd.Series) -> pd.Series:
    """15-minute slot of the (UTC) day, 0..95."""
    return ts.dt.hour * 4 + ts.dt.minute // 15


def build_load_profile(raw_df: pd.DataFrame) -> Dict[str, Dict[str, float]]:
    """Per-meter median mean-phase current per 15-minute slot.

    Must be fitted on NORMAL training rows only so faults (incl. theft) don't pollute it.
    """
    d = raw_df.copy()
    d["current_mean"] = (d["current_a"] + d["current_b"] + d["current_c"]) / 3.0
    d["slot"] = time_slot(pd.to_datetime(d["timestamp"], utc=True))
    med = d.groupby(["meter_id", "slot"])["current_mean"].median()
    profile: Dict[str, Dict[str, float]] = {}
    for (m, slot), v in med.items():
        profile.setdefault(str(m), {})[str(int(slot))] = float(v)
    return profile


def engineer_features(
    df: pd.DataFrame, load_profile: Optional[Dict[str, Dict[str, float]]] = None
) -> pd.DataFrame:
    """Compute time-series and electrical domain features per smart meter.

    Accepts a DataFrame containing at least:
    timestamp, meter_id, voltage_a, voltage_b, voltage_c,
    current_a, current_b, current_c, power_factor, frequency.
    """
    if df.empty:
        return pd.DataFrame(columns= list(df.columns) + FEATURE_COLUMNS)

    out = df.copy()
    out["_parsed_ts"] = pd.to_datetime(out["timestamp"], utc=True)
    out = out.sort_values(["meter_id", "_parsed_ts"]).reset_index(drop=True)

    # 1. Three-phase means
    out["voltage_mean"] = (out["voltage_a"] + out["voltage_b"] + out["voltage_c"]) / 3.0
    out["current_mean"] = (out["current_a"] + out["current_b"] + out["current_c"]) / 3.0

    # 1b. Load vs. typical load for this meter/time-of-day (0.0 when no profile is available)
    slots = time_slot(out["_parsed_ts"])
    if load_profile:
        expected = np.array(
            [load_profile.get(str(m), {}).get(str(int(sl)), np.nan) for m, sl in zip(out["meter_id"], slots)],
            dtype=float,
        )
        out["load_vs_profile"] = np.where(
            np.isnan(expected), 0.0, out["current_mean"] / (expected + EPS) - 1.0
        )
    else:
        out["load_vs_profile"] = 0.0

    # 2. Per-phase ratios
    out["voltage_ratio_ab"] = out["voltage_a"] / (out["voltage_b"] + EPS)
    out["voltage_ratio_bc"] = out["voltage_b"] / (out["voltage_c"] + EPS)
    out["voltage_ratio_ca"] = out["voltage_c"] / (out["voltage_a"] + EPS)

    out["current_ratio_ab"] = out["current_a"] / (out["current_b"] + EPS)
    out["current_ratio_bc"] = out["current_b"] / (out["current_c"] + EPS)
    out["current_ratio_ca"] = out["current_c"] / (out["current_a"] + EPS)

    # 3. NEMA-style phase imbalance index: max deviation from 3-phase average / 3-phase average
    v_dev_a = (out["voltage_a"] - out["voltage_mean"]).abs()
    v_dev_b = (out["voltage_b"] - out["voltage_mean"]).abs()
    v_dev_c = (out["voltage_c"] - out["voltage_mean"]).abs()
    out["voltage_imbalance_nema"] = np.maximum.reduce([v_dev_a, v_dev_b, v_dev_c]) / (
        out["voltage_mean"] + EPS
    )

    i_dev_a = (out["current_a"] - out["current_mean"]).abs()
    i_dev_b = (out["current_b"] - out["current_mean"]).abs()
    i_dev_c = (out["current_c"] - out["current_mean"]).abs()
    out["current_imbalance_nema"] = np.maximum.reduce([i_dev_a, i_dev_b, i_dev_c]) / (
        out["current_mean"] + EPS
    )

    # 4. Nominal power factor deviation
    out["pf_deviation_nominal"] = NOMINAL_POWER_FACTOR - out["power_factor"]

    # 5. Per-meter time-based rolling statistics over 5m, 15m, and 60m windows
    grouped_frames: List[pd.DataFrame] = []
    for _, grp in out.groupby("meter_id", sort=False):
        g = grp.set_index("_parsed_ts")

        # Shift by 1 reading when computing baseline reference where multiple rows exist
        # so an anomalous spike doesn't immediately corrupt its own baseline
        for win_label, win_str in [("5m", "5min"), ("15m", "15min"), ("60m", "60min")]:
            v_roll = g["voltage_mean"].rolling(win_str, min_periods=1)
            c_roll = g["current_mean"].rolling(win_str, min_periods=1)

            g[f"voltage_mean_roll_mean_{win_label}"] = v_roll.mean()
            g[f"voltage_mean_roll_std_{win_label}"] = v_roll.std().fillna(0.0)
            g[f"current_mean_roll_mean_{win_label}"] = c_roll.mean()
            g[f"current_mean_roll_std_{win_label}"] = c_roll.std().fillna(0.0)

        # Compute clean 60-minute baseline using normal-weighted rolling median/mean
        base_c_a = g["current_a"].shift(1).rolling("60min", min_periods=1).median().fillna(g["current_a"])
        base_c_b = g["current_b"].shift(1).rolling("60min", min_periods=1).median().fillna(g["current_b"])
        base_c_c = g["current_c"].shift(1).rolling("60min", min_periods=1).median().fillna(g["current_c"])
        base_c_mean = g["current_mean"].shift(1).rolling("60min", min_periods=1).median().fillna(g["current_mean"])

        base_v_a = g["voltage_a"].shift(1).rolling("60min", min_periods=1).median().fillna(NOMINAL_VOLTAGE)
        base_v_b = g["voltage_b"].shift(1).rolling("60min", min_periods=1).median().fillna(NOMINAL_VOLTAGE)
        base_v_c = g["voltage_c"].shift(1).rolling("60min", min_periods=1).median().fillna(NOMINAL_VOLTAGE)
        base_pf = g["power_factor"].shift(1).rolling("60min", min_periods=1).median().fillna(NOMINAL_POWER_FACTOR)

        g["current_a_rel_dev_60m"] = (g["current_a"] - base_c_a) / (base_c_a + EPS)
        g["current_b_rel_dev_60m"] = (g["current_b"] - base_c_b) / (base_c_b + EPS)
        g["current_c_rel_dev_60m"] = (g["current_c"] - base_c_c) / (base_c_c + EPS)
        g["current_mean_rel_dev_60m"] = (g["current_mean"] - base_c_mean) / (base_c_mean + EPS)

        g["voltage_a_rel_dev_60m"] = (g["voltage_a"] - base_v_a) / (base_v_a + EPS)
        g["voltage_b_rel_dev_60m"] = (g["voltage_b"] - base_v_b) / (base_v_b + EPS)
        g["voltage_c_rel_dev_60m"] = (g["voltage_c"] - base_v_c) / (base_v_c + EPS)

        g["pf_deviation_rolling_60m"] = (g["power_factor"] - base_pf) / (base_pf + EPS)

        # Rate of change (step-over-step difference)
        g["current_mean_roc"] = g["current_mean"].diff().fillna(0.0)
        g["voltage_mean_roc"] = g["voltage_mean"].diff().fillna(0.0)
        g["pf_roc"] = g["power_factor"].diff().fillna(0.0)

        grouped_frames.append(g.reset_index())

    combined = pd.concat(grouped_frames, ignore_index=True)
    combined = combined.drop(columns=["_parsed_ts"])
    return combined


def compute_psi(
    expected_bin_edges: List[float],
    expected_proportions: List[float],
    actual_values: np.ndarray,
) -> float:
    """Calculate Population Stability Index (PSI) between training bins and recent data.

    PSI = sum( (actual_p - expected_p) * ln(actual_p / expected_p) )
    Values > 0.2 indicate significant distributional drift.
    """
    if len(actual_values) == 0:
        return 0.0

    edges = np.array(expected_bin_edges, dtype=float)
    # Extend outer edges to -inf / +inf so out-of-range values land in outer bins
    edges_ext = edges.copy()
    edges_ext[0] = -np.inf
    edges_ext[-1] = np.inf

    counts, _ = np.histogram(actual_values, bins=edges_ext)
    actual_prop = counts / max(len(actual_values), 1)
    expected_prop = np.array(expected_proportions, dtype=float)

    # Clamp zero proportions to small epsilon to avoid log(0)
    actual_prop = np.clip(actual_prop, 1e-4, 1.0)
    expected_prop = np.clip(expected_prop, 1e-4, 1.0)

    psi_val = float(np.sum((actual_prop - expected_prop) * np.log(actual_prop / expected_prop)))
    return round(max(0.0, psi_val), 4)


def build_reference_psi_bins(
    df_features: pd.DataFrame,
    monitored_cols: List[str],
    num_bins: int = 10,
) -> Dict[str, Dict[str, List[float]]]:
    """Build quantile bin edges and expected proportions on training normal data."""
    ref_distributions: Dict[str, Dict[str, List[float]]] = {}
    for col in monitored_cols:
        vals = df_features[col].dropna().to_numpy(dtype=float)
        if len(vals) < num_bins:
            continue
        quantiles = np.linspace(0.0, 1.0, num_bins + 1)
        edges = np.quantile(vals, quantiles)
        # Ensure strictly increasing edges even if feature has low variance
        for i in range(1, len(edges)):
            if edges[i] <= edges[i - 1]:
                edges[i] = edges[i - 1] + 1e-4
        counts, _ = np.histogram(vals, bins=edges)
        proportions = (counts / max(len(vals), 1)).tolist()
        ref_distributions[col] = {
            "bin_edges": edges.tolist(),
            "proportions": proportions,
        }
    return ref_distributions
