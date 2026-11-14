"""CLI entrypoint for the GridSense Smart-Meter Simulator.

Supports two primary modes:
1. `stream`: Emits real-time meter batches every second via pluggable transport (HTTP POST default).
2. `historical`: Generates labelled historical CSV data (default 30 days) for ML training.
"""

import argparse
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
from dotenv import load_dotenv

from simulator.engine import SmartMeterSimulator
from simulator.models import FaultType
from simulator.transports import CsvFileTransport, HttpPostTransport

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("simulator.cli")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GridSense Smart-Meter Simulator")
    parser.add_argument(
        "--mode",
        choices=["stream", "historical", "inject-theft"],
        default="stream",
        help="Run mode: live streaming ('stream'), historical CSV ('historical'), or one-shot theft trigger ('inject-theft')",
    )
    parser.add_argument(
        "--target-meter",
        type=str,
        default="MTR-001",
        help="Target meter ID for 'inject-theft' demo mode (default: MTR-001)",
    )
    parser.add_argument(
        "--meters",
        type=int,
        default=int(os.getenv("SIMULATOR_METERS", "20")),
        help="Number of 3-phase smart meters to simulate (default: 20)",
    )
    parser.add_argument(
        "--fault-prob",
        type=float,
        default=float(os.getenv("SIMULATOR_FAULT_PROB", "0.05")),
        help="Probability of injecting a fault on a meter per step (default: 0.05)",
    )
    parser.add_argument(
        "--interval-sec",
        type=float,
        default=float(os.getenv("SIMULATOR_INTERVAL_SEC", "1.0")),
        help="Streaming interval in seconds (default: 1.0)",
    )
    parser.add_argument(
        "--endpoint",
        type=str,
        default=os.getenv("BACKEND_INGEST_URL", "http://localhost:4000/api/readings"),
        help="Backend ingestion endpoint for HTTP POST transport",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Number of days of historical data to generate in 'historical' mode (default: 30)",
    )
    parser.add_argument(
        "--interval-minutes",
        type=int,
        default=15,
        help="Sampling interval in minutes for historical CSV generation (default: 15)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="simulator/data/historical_readings_30d.csv",
        help="Output CSV path for historical generation",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducible simulation",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sim = SmartMeterSimulator(
        num_meters=args.meters,
        fault_probability=args.fault_prob,
        seed=args.seed,
    )

    if args.mode == "historical":
        out_path = Path(args.output)
        logger.info(
            "Generating %d days of historical data for %d meters (every %d min) -> %s",
            args.days,
            args.meters,
            args.interval_minutes,
            out_path,
        )
        rows = sim.generate_historical_csv(
            output_path=out_path,
            days=args.days,
            interval_minutes=args.interval_minutes,
        )
        logger.info("Historical dataset complete: %d rows written to %s", rows, out_path)
    elif args.mode == "inject-theft":
        api_key = os.getenv("INGEST_API_KEY", "gridsense-ingest-dev-key")
        transport = HttpPostTransport(endpoint_url=args.endpoint, api_key=api_key)
        sim.force_fault(
            args.target_meter,
            FaultType.POWER_THEFT,
            duration_steps=5,
            severity_factor=0.45,
        )
        now = datetime.now(timezone.utc)
        reading = sim.generate_reading_for_meter(args.target_meter, now, step_seconds=args.interval_sec)
        ok = transport.send_batch([reading])
        transport.close()
        logger.info(
            "Injected power-theft event on %s -> %s (V=%.1f/%.1f/%.1fV, I=%.2f/%.2f/%.2fA, delivered=%s)",
            args.target_meter,
            args.endpoint,
            reading.voltage_a,
            reading.voltage_b,
            reading.voltage_c,
            reading.current_a,
            reading.current_b,
            reading.current_c,
            ok,
        )
    else:
        logger.info(
            "Starting real-time simulator for %d meters -> %s (interval=%.1fs, fault_prob=%.2f)",
            args.meters,
            args.endpoint,
            args.interval_sec,
            args.fault_prob,
        )
        transport = HttpPostTransport(
            endpoint_url=args.endpoint,
            api_key=os.getenv("INGEST_API_KEY", "gridsense-ingest-dev-key"),
        )
        sim.run_stream(transport=transport, interval_sec=args.interval_sec)


if __name__ == "__main__":
    main()
