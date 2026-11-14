"""GridSense Smart-Meter Simulator Engine.

Simulates N three-phase smart meters with realistic daily load curves (night trough,
morning bump, evening peak), per-meter baseline load profiles, realistic sensor noise,
and configurable fault/power-theft injection.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
import random
import time
from typing import Dict, List, Optional

from simulator.models import FaultType, MeterReading, PHYSICAL_BOUNDS
from simulator.transports import CsvFileTransport, Transport


@dataclass
class ActiveFaultState:
    """Tracks multi-step fault episodes per meter so faults persist realistically."""

    fault_type: FaultType
    remaining_steps: int
    affected_phase: str  # 'A', 'B', or 'C'
    severity_factor: float


def clamp(val: float, low: float, high: float) -> float:
    """Clamp a value within [low, high]."""
    return max(low, min(high, val))


class SmartMeterSimulator:
    """Simulates a fleet of 3-phase smart meters with realistic load and fault profiles."""

    FAULT_TYPES_LIST = [
        FaultType.PHASE_IMBALANCE,
        FaultType.OVERCURRENT_SPIKE,
        FaultType.HARMONIC_DISTORTION,
        FaultType.POWER_THEFT,
        FaultType.VOLTAGE_SAG,
        FaultType.VOLTAGE_SWELL,
    ]

    def __init__(
        self,
        num_meters: int = 20,
        fault_probability: float = 0.05,
        seed: Optional[int] = 42,
        fault_weights: Optional[Dict[FaultType, float]] = None,
    ) -> None:
        self.num_meters = num_meters
        self.fault_probability = clamp(fault_probability, 0.0, 1.0)
        self.rng = random.Random(seed)

        self.meter_ids = [f"MTR-{i:03d}" for i in range(1, num_meters + 1)]

        # Each meter gets a reproducible baseline current scale (10A to 28A) and cumulative energy
        self.meter_base_current: Dict[str, float] = {
            m_id: self.rng.uniform(12.0, 25.0) for m_id in self.meter_ids
        }
        self.cumulative_kwh: Dict[str, float] = {
            m_id: round(self.rng.uniform(1000.0, 5000.0), 3) for m_id in self.meter_ids
        }
        self.active_faults: Dict[str, Optional[ActiveFaultState]] = {
            m_id: None for m_id in self.meter_ids
        }

        if fault_weights:
            self.fault_weights = [
                fault_weights.get(ft, 1.0) for ft in self.FAULT_TYPES_LIST
            ]
        else:
            # Uniform distribution across all 6 anomalous conditions by default
            self.fault_weights = [1.0 for _ in self.FAULT_TYPES_LIST]

    @staticmethod
    def daily_load_multiplier(timestamp: datetime, rng: random.Random) -> float:
        """Compute daily load factor based on hour of day.

        - Low at night (00:00 - 05:00): ~0.35 - 0.50
        - Morning ramp (07:00 - 10:00): ~0.85 - 1.05
        - Midday plateau (11:00 - 16:00): ~0.75 - 0.90
        - Evening peak (18:00 - 22:00): ~1.30 - 1.65
        """
        hour = timestamp.hour + timestamp.minute / 60.0

        # Night baseline + morning Gaussian + strong evening Gaussian peak
        night_base = 0.40
        morning_bump = 0.45 * math.exp(-((hour - 8.5) ** 2) / (2 * 2.0**2))
        midday_level = 0.30 * math.exp(-((hour - 13.5) ** 2) / (2 * 3.0**2))
        evening_peak = 1.05 * math.exp(-((hour - 19.75) ** 2) / (2 * 2.2**2))

        variation = rng.gauss(0.0, 0.04)
        multiplier = night_base + morning_bump + midday_level + evening_peak + variation
        return clamp(multiplier, 0.25, 2.0)

    def force_fault(
        self,
        meter_id: str,
        fault_type: FaultType,
        duration_steps: int = 5,
        affected_phase: str = "B",
        severity_factor: Optional[float] = None,
    ) -> None:
        """Explicitly inject a specific fault on a given meter (useful for tests & demos)."""
        if severity_factor is None:
            severity_factor = self._sample_severity(fault_type)
        self.active_faults[meter_id] = ActiveFaultState(
            fault_type=fault_type,
            remaining_steps=duration_steps,
            affected_phase=affected_phase,
            severity_factor=severity_factor,
        )

    def _sample_severity(self, fault_type: FaultType) -> float:
        """Sample realistic severity parameters matching Phase 1 specifications."""
        if fault_type == FaultType.PHASE_IMBALANCE:
            # 15-30% deviation; choose upward or downward deviation
            direction = self.rng.choice([-1.0, 1.0])
            mag = self.rng.uniform(0.18, 0.29)
            return 1.0 + direction * mag
        if fault_type == FaultType.OVERCURRENT_SPIKE:
            # 2-3x normal current
            return self.rng.uniform(2.1, 2.95)
        if fault_type == FaultType.HARMONIC_DISTORTION:
            # Power factor drop factor & waveform distortion factor
            return self.rng.uniform(0.58, 0.74)
        if fault_type == FaultType.POWER_THEFT:
            # Sudden 30-60% load drop (multiplier 0.40 to 0.68 of normal load)
            return self.rng.uniform(0.41, 0.67)
        if fault_type == FaultType.VOLTAGE_SAG:
            # Drop voltage below 205V (approx 0.78 - 0.87 of 230V)
            return self.rng.uniform(0.78, 0.86)
        if fault_type == FaultType.VOLTAGE_SWELL:
            # Swell voltage above 254V (approx 1.11 - 1.18 of 230V)
            return self.rng.uniform(1.12, 1.18)
        return 1.0

    def _maybe_start_or_advance_fault(self, meter_id: str) -> Optional[ActiveFaultState]:
        """Manage active fault lifecycle or probabilistically trigger a new fault."""
        state = self.active_faults.get(meter_id)
        if state is not None:
            if state.remaining_steps > 0:
                state.remaining_steps -= 1
                return state
            self.active_faults[meter_id] = None

        if self.fault_probability > 0.0 and self.rng.random() < self.fault_probability:
            chosen_fault = self.rng.choices(
                self.FAULT_TYPES_LIST, weights=self.fault_weights, k=1
            )[0]
            # Short duration for spikes (1-3 steps), longer for theft/imbalance (3-10 steps)
            if chosen_fault == FaultType.OVERCURRENT_SPIKE:
                duration = self.rng.randint(1, 3)
            elif chosen_fault == FaultType.POWER_THEFT:
                duration = self.rng.randint(4, 12)
            else:
                duration = self.rng.randint(2, 6)

            new_state = ActiveFaultState(
                fault_type=chosen_fault,
                remaining_steps=duration - 1,
                affected_phase=self.rng.choice(["A", "B", "C"]),
                severity_factor=self._sample_severity(chosen_fault),
            )
            self.active_faults[meter_id] = new_state
            return new_state

        return None

    def generate_reading_for_meter(
        self,
        meter_id: str,
        timestamp: datetime,
        step_seconds: float = 1.0,
    ) -> MeterReading:
        """Generate a single 3-phase reading for a specific meter and timestamp."""
        # 1. Nominal baseline values with realistic Gaussian noise
        v_a = self.rng.gauss(230.0, 1.4)
        v_b = self.rng.gauss(230.0, 1.4)
        v_c = self.rng.gauss(230.0, 1.4)

        load_mult = self.daily_load_multiplier(timestamp, self.rng)
        base_i = self.meter_base_current[meter_id] * load_mult

        i_a = max(0.5, base_i * self.rng.gauss(1.0, 0.025))
        i_b = max(0.5, base_i * self.rng.gauss(1.0, 0.025))
        i_c = max(0.5, base_i * self.rng.gauss(1.0, 0.025))

        pf = clamp(self.rng.gauss(0.95, 0.012), 0.88, 0.995)
        freq = clamp(self.rng.gauss(50.0, 0.04), 49.8, 50.2)
        label = FaultType.NORMAL.value

        # 2. Apply fault transformation if active
        fault_state = self._maybe_start_or_advance_fault(meter_id)
        if fault_state is not None:
            ft = fault_state.fault_type
            sev = fault_state.severity_factor
            phase = fault_state.affected_phase
            label = ft.value

            if ft == FaultType.PHASE_IMBALANCE:
                # One phase current deviates 15-30% and voltage droops/rises slightly on that phase
                if phase == "A":
                    i_a *= sev
                    v_a *= 1.0 - (sev - 1.0) * 0.35
                elif phase == "B":
                    i_b *= sev
                    v_b *= 1.0 - (sev - 1.0) * 0.35
                else:
                    i_c *= sev
                    v_c *= 1.0 - (sev - 1.0) * 0.35

            elif ft == FaultType.OVERCURRENT_SPIKE:
                # Short duration 2-3x normal current across phases with slight voltage sag
                i_a *= sev
                i_b *= sev * self.rng.uniform(0.95, 1.05)
                i_c *= sev * self.rng.uniform(0.95, 1.05)
                v_a -= self.rng.uniform(4.0, 8.0)
                v_b -= self.rng.uniform(4.0, 8.0)
                v_c -= self.rng.uniform(4.0, 8.0)

            elif ft == FaultType.HARMONIC_DISTORTION:
                # Power factor drops markedly (0.58-0.74) with uneven current waveform distortion
                pf = sev
                i_a *= self.rng.uniform(1.12, 1.28)
                i_b *= self.rng.uniform(0.85, 1.22)
                i_c *= self.rng.uniform(1.10, 1.30)
                freq += self.rng.choice([-1.0, 1.0]) * self.rng.uniform(0.18, 0.35)

            elif ft == FaultType.POWER_THEFT:
                # Sudden 30-60% load drop while voltage stays completely normal (bypassed meter)
                i_a *= sev
                i_b *= sev
                i_c *= sev
                # Voltage stays ~230V normal

            elif ft == FaultType.VOLTAGE_SAG:
                # Voltage sag (e.g., 178V - 198V)
                v_a *= sev
                v_b *= sev * self.rng.uniform(0.98, 1.02)
                v_c *= sev * self.rng.uniform(0.98, 1.02)

            elif ft == FaultType.VOLTAGE_SWELL:
                # Voltage swell (e.g., 256V - 272V)
                v_a *= sev
                v_b *= sev * self.rng.uniform(0.98, 1.02)
                v_c *= sev * self.rng.uniform(0.98, 1.02)

        # 3. Clamp all values to physical limits
        v_a = round(clamp(v_a, PHYSICAL_BOUNDS["voltage_min"], PHYSICAL_BOUNDS["voltage_max"]), 2)
        v_b = round(clamp(v_b, PHYSICAL_BOUNDS["voltage_min"], PHYSICAL_BOUNDS["voltage_max"]), 2)
        v_c = round(clamp(v_c, PHYSICAL_BOUNDS["voltage_min"], PHYSICAL_BOUNDS["voltage_max"]), 2)

        i_a = round(clamp(i_a, PHYSICAL_BOUNDS["current_min"], PHYSICAL_BOUNDS["current_max"]), 2)
        i_b = round(clamp(i_b, PHYSICAL_BOUNDS["current_min"], PHYSICAL_BOUNDS["current_max"]), 2)
        i_c = round(clamp(i_c, PHYSICAL_BOUNDS["current_min"], PHYSICAL_BOUNDS["current_max"]), 2)

        pf = round(clamp(pf, PHYSICAL_BOUNDS["power_factor_min"], PHYSICAL_BOUNDS["power_factor_max"]), 4)
        freq = round(clamp(freq, PHYSICAL_BOUNDS["frequency_min"], PHYSICAL_BOUNDS["frequency_max"]), 3)

        # 4. Compute active power (kW) across three phases: P = (Va*Ia + Vb*Ib + Vc*Ic) * PF / 1000
        active_power_kw = ((v_a * i_a + v_b * i_b + v_c * i_c) * pf) / 1000.0
        delta_kwh = active_power_kw * (step_seconds / 3600.0)
        self.cumulative_kwh[meter_id] = round(self.cumulative_kwh[meter_id] + delta_kwh, 4)

        iso_ts = timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

        return MeterReading(
            timestamp=iso_ts,
            meter_id=meter_id,
            voltage_a=v_a,
            voltage_b=v_b,
            voltage_c=v_c,
            current_a=i_a,
            current_b=i_b,
            current_c=i_c,
            power_factor=pf,
            frequency=freq,
            active_energy_kwh=self.cumulative_kwh[meter_id],
            fault_label=label,
        )

    def generate_step(
        self, timestamp: datetime, step_seconds: float = 1.0
    ) -> List[MeterReading]:
        """Generate one batch of readings across all N meters for a single timestamp."""
        return [
            self.generate_reading_for_meter(m_id, timestamp, step_seconds=step_seconds)
            for m_id in self.meter_ids
        ]

    def generate_historical_csv(
        self,
        output_path: Path,
        days: int = 30,
        interval_minutes: int = 15,
        start_time: Optional[datetime] = None,
    ) -> int:
        """Generate labelled historical dataset (default >= 30 days) to CSV.

        Returns the total number of rows written.
        """
        if start_time is None:
            start_time = datetime.now(timezone.utc) - timedelta(days=days)

        step_seconds = interval_minutes * 60.0
        total_steps = int((days * 24 * 60) // interval_minutes)

        transport = CsvFileTransport(output_path)
        total_rows = 0
        try:
            current_ts = start_time
            for _ in range(total_steps):
                batch = self.generate_step(current_ts, step_seconds=step_seconds)
                transport.send_batch(batch)
                total_rows += len(batch)
                current_ts += timedelta(minutes=interval_minutes)
        finally:
            transport.close()

        return total_rows

    def run_stream(
        self,
        transport: Transport,
        interval_sec: float = 1.0,
        max_steps: Optional[int] = None,
    ) -> None:
        """Continuously emit readings every `interval_sec` seconds to the given transport."""
        step = 0
        try:
            while max_steps is None or step < max_steps:
                now = datetime.now(timezone.utc)
                batch = self.generate_step(now, step_seconds=interval_sec)
                transport.send_batch(batch)
                step += 1
                if max_steps is None or step < max_steps:
                    time.sleep(interval_sec)
        finally:
            transport.close()
