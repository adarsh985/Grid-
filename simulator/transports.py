"""Pluggable transport layer for emitting simulated smart-meter batches.

Supports an HTTP POST transport (default for local/Docker real-time ingestion),
a CSV file transport for historical dataset generation, and an in-memory buffer
transport for deterministic unit testing or Kafka-like queue adapters.
"""

from abc import ABC, abstractmethod
import csv
import logging
from pathlib import Path
from typing import List, Optional
import requests

from simulator.models import MeterReading

logger = logging.getLogger(__name__)


class Transport(ABC):
    """Abstract base class for reading stream transports (Kafka-like interface)."""

    @abstractmethod
    def send_batch(self, readings: List[MeterReading]) -> bool:
        """Emit a batch of meter readings to the target sink."""
        raise NotImplementedError

    def close(self) -> None:
        """Clean up transport resources if needed."""


class HttpPostTransport(Transport):
    """Sends batches of meter readings via HTTP POST to the backend ingestion API."""

    def __init__(self, endpoint_url: str, timeout_sec: float = 5.0, api_key: Optional[str] = None) -> None:
        self.endpoint_url = endpoint_url
        self.timeout_sec = timeout_sec
        self.session = requests.Session()
        if api_key:
            self.session.headers.update({"X-API-Key": api_key})

    def send_batch(self, readings: List[MeterReading]) -> bool:
        payload = {"readings": [r.to_dict() for r in readings]}
        try:
            response = self.session.post(
                self.endpoint_url,
                json=payload,
                timeout=self.timeout_sec,
            )
            response.raise_for_status()
            return True
        except requests.RequestException as exc:
            logger.warning("HTTP transport failed to post batch (%d readings) to %s: %s", len(readings), self.endpoint_url, exc)
            return False

    def close(self) -> None:
        self.session.close()


class CsvFileTransport(Transport):
    """Streams batches of meter readings to a CSV file for ML model training."""

    FIELDNAMES = [
        "timestamp",
        "meter_id",
        "voltage_a",
        "voltage_b",
        "voltage_c",
        "current_a",
        "current_b",
        "current_c",
        "power_factor",
        "frequency",
        "active_energy_kwh",
        "fault_label",
    ]

    def __init__(self, file_path: Path) -> None:
        self.file_path = Path(file_path)
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.file_path.open("w", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(self._file, fieldnames=self.FIELDNAMES)
        self._writer.writeheader()

    def send_batch(self, readings: List[MeterReading]) -> bool:
        for reading in readings:
            self._writer.writerow(reading.to_dict())
        return True

    def close(self) -> None:
        if self._file and not self._file.closed:
            self._file.flush()
            self._file.close()


class InMemoryQueueTransport(Transport):
    """Stores emitted batches in an in-memory queue for testing and inspection."""

    def __init__(self) -> None:
        self.batches: List[List[MeterReading]] = []

    def send_batch(self, readings: List[MeterReading]) -> bool:
        self.batches.append(list(readings))
        return True

    @property
    def all_readings(self) -> List[MeterReading]:
        return [r for batch in self.batches for r in batch]
