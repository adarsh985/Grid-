"""Data models and physical range bounds for GridSense smart meter readings."""

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Dict


class FaultType(str, Enum):
    """Supported electrical fault and anomaly labels."""

    NORMAL = "normal"
    PHASE_IMBALANCE = "phase_imbalance"
    OVERCURRENT_SPIKE = "overcurrent_spike"
    HARMONIC_DISTORTION = "harmonic_distortion"
    POWER_THEFT = "power_theft"
    VOLTAGE_SAG = "voltage_sag"
    VOLTAGE_SWELL = "voltage_swell"


# Physical limits used to clamp readings and validate simulator integrity
PHYSICAL_BOUNDS = {
    "voltage_min": 140.0,
    "voltage_max": 300.0,
    "current_min": 0.0,
    "current_max": 250.0,
    "power_factor_min": 0.30,
    "power_factor_max": 1.00,
    "frequency_min": 47.0,
    "frequency_max": 53.0,
}


@dataclass
class MeterReading:
    """Single 3-phase smart meter telemetry record with ground-truth label."""

    timestamp: str
    meter_id: str
    voltage_a: float
    voltage_b: float
    voltage_c: float
    current_a: float
    current_b: float
    current_c: float
    power_factor: float
    frequency: float
    active_energy_kwh: float
    fault_label: str = FaultType.NORMAL.value

    def to_dict(self) -> Dict[str, Any]:
        """Serialize reading to a plain dictionary for JSON/CSV output."""
        return asdict(self)
