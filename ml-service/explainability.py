"""Plain-language explainability engine for GridSense anomaly detection.

For each flagged reading, identifies the top 3 contributing features and expresses
their deviation from the rolling 60-minute baseline or nominal reference in clear,
operator-friendly language (e.g., "Phase B current is 38% above its 60-minute baseline").
"""

from typing import Any, Dict, List
import pandas as pd

NOMINAL_VOLTAGE = 230.0
NOMINAL_PF = 0.95
NOMINAL_FREQ = 50.0


def explain_reading(row: pd.Series, feature_zscores: Dict[str, float]) -> List[Dict[str, Any]]:
    """Return the top 3 contributing features with plain-language explanations.

    Each item in the returned list has:
      - feature: str (internal feature identifier)
      - deviation_pct: float (percentage deviation from baseline/nominal)
      - z_score: float (standardized anomaly contribution score)
      - description: str (plain-language sentence)
    """
    candidates: List[Dict[str, Any]] = []

    # 1. Per-phase current deviations from 60-minute rolling baseline
    for phase in ["a", "b", "c"]:
        phase_upper = phase.upper()
        rel_col = f"current_{phase}_rel_dev_60m"
        raw_col = f"current_{phase}"
        rel_val = float(row.get(rel_col, 0.0))
        pct = round(abs(rel_val) * 100.0, 1)
        direction = "above" if rel_val >= 0 else "below"
        z = max(abs(feature_zscores.get(rel_col, 0.0)), abs(feature_zscores.get(raw_col, 0.0)), abs(rel_val) * 6.0)
        candidates.append(
            {
                "feature": f"current_{phase}",
                "deviation_pct": round(rel_val * 100.0, 1),
                "z_score": round(float(z), 2),
                "description": (
                    f"Phase {phase_upper} current ({row.get(raw_col, 0.0):.1f}A) is "
                    f"{pct:.0f}% {direction} its 60-minute baseline"
                ),
            }
        )

    # 2. Per-phase voltage deviations from 60-minute rolling baseline / 230V nominal
    for phase in ["a", "b", "c"]:
        phase_upper = phase.upper()
        rel_col = f"voltage_{phase}_rel_dev_60m"
        raw_col = f"voltage_{phase}"
        v_val = float(row.get(raw_col, NOMINAL_VOLTAGE))
        rel_val = float(row.get(rel_col, (v_val - NOMINAL_VOLTAGE) / NOMINAL_VOLTAGE))
        # Fall back to nominal comparison if rolling baseline was already shifted
        nom_rel = (v_val - NOMINAL_VOLTAGE) / NOMINAL_VOLTAGE
        effective_rel = rel_val if abs(rel_val) >= abs(nom_rel) else nom_rel
        pct = round(abs(effective_rel) * 100.0, 1)
        direction = "above" if effective_rel >= 0 else "below"
        z = max(abs(feature_zscores.get(rel_col, 0.0)), abs(feature_zscores.get(raw_col, 0.0)), abs(effective_rel) * 12.0)
        candidates.append(
            {
                "feature": f"voltage_{phase}",
                "deviation_pct": round(effective_rel * 100.0, 1),
                "z_score": round(float(z), 2),
                "description": (
                    f"Phase {phase_upper} voltage ({v_val:.1f}V) is "
                    f"{pct:.0f}% {direction} its 60-minute baseline"
                ),
            }
        )

    # 3. NEMA Phase Imbalance Index (Current)
    c_imb = float(row.get("current_imbalance_nema", 0.0))
    c_imb_pct = round(c_imb * 100.0, 1)
    z_imb = max(abs(feature_zscores.get("current_imbalance_nema", 0.0)), c_imb * 10.0)
    candidates.append(
        {
            "feature": "current_imbalance_nema",
            "deviation_pct": c_imb_pct,
            "z_score": round(float(z_imb), 2),
            "description": (
                f"Phase current imbalance index is {c_imb_pct:.0f}% above balanced 3-phase baseline"
            ),
        }
    )

    # 4. Power factor deviation from 60-minute baseline / nominal
    pf_val = float(row.get("power_factor", NOMINAL_PF))
    pf_rel = float(row.get("pf_deviation_rolling_60m", (pf_val - NOMINAL_PF) / NOMINAL_PF))
    nom_pf_rel = (pf_val - NOMINAL_PF) / NOMINAL_PF
    eff_pf_rel = pf_rel if abs(pf_rel) >= abs(nom_pf_rel) else nom_pf_rel
    pf_pct = round(abs(eff_pf_rel) * 100.0, 1)
    pf_dir = "above" if eff_pf_rel >= 0 else "below"
    z_pf = max(
        abs(feature_zscores.get("power_factor", 0.0)),
        abs(feature_zscores.get("pf_deviation_nominal", 0.0)),
        abs(eff_pf_rel) * 10.0,
    )
    candidates.append(
        {
            "feature": "power_factor",
            "deviation_pct": round(eff_pf_rel * 100.0, 1),
            "z_score": round(float(z_pf), 2),
            "description": (
                f"Power factor ({pf_val:.2f}) is {pf_pct:.0f}% {pf_dir} its 60-minute baseline"
            ),
        }
    )

    # 5. Three-phase aggregate load drop/spike relative to 60-minute baseline
    c_mean_rel = float(row.get("current_mean_rel_dev_60m", 0.0))
    c_mean_pct = round(abs(c_mean_rel) * 100.0, 1)
    c_mean_dir = "above" if c_mean_rel >= 0 else "below"
    z_cmean = max(abs(feature_zscores.get("current_mean_rel_dev_60m", 0.0)), abs(c_mean_rel) * 7.5)
    candidates.append(
        {
            "feature": "current_mean_rel_dev_60m",
            "deviation_pct": round(c_mean_rel * 100.0, 1),
            "z_score": round(float(z_cmean), 2),
            "description": (
                f"Three-phase average load ({row.get('current_mean', 0.0):.1f}A) is "
                f"{c_mean_pct:.0f}% {c_mean_dir} its 60-minute baseline"
            ),
        }
    )

    # 6. Load relative to this meter's typical level for the time of day (theft signal)
    lvp = float(row.get("load_vs_profile", 0.0))
    if lvp != 0.0:
        lvp_dir = "above" if lvp >= 0 else "below"
        candidates.append(
            {
                "feature": "load_vs_profile",
                "deviation_pct": round(lvp * 100.0, 1),
                "z_score": round(float(max(abs(feature_zscores.get("load_vs_profile", 0.0)), abs(lvp) * 8.0)), 2),
                "description": (
                    f"Load is {abs(lvp) * 100:.0f}% {lvp_dir} this meter's typical level for this time of day"
                ),
            }
        )

    # Sort descending by z_score and return top 3
    candidates.sort(key=lambda item: item["z_score"], reverse=True)
    return candidates[:3]
