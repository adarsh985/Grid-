#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Set DATABASE_URL in .env (for example a free Neon Postgres URI or local postgresql:// URI) and retry."
  exit 1
fi

export JWT_SECRET="${JWT_SECRET:-change_me_in_production_gridsense_jwt_secret_2026}"
export INGEST_API_KEY="${INGEST_API_KEY:-gridsense-ingest-dev-key}"
export ML_SERVICE_URL="${ML_SERVICE_URL:-http://127.0.0.1:8000}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5173}"
export BACKEND_INGEST_URL="${BACKEND_INGEST_URL:-http://127.0.0.1:4000/api/readings}"
export BACKEND_PROXY_URL="${BACKEND_PROXY_URL:-http://127.0.0.1:4000}"
export ML_PROXY_URL="${ML_PROXY_URL:-http://127.0.0.1:8000}"

PY_BIN="${ROOT_DIR}/.venv/bin/python"
UVICORN_BIN="${ROOT_DIR}/.venv/bin/uvicorn"
if [ ! -x "$PY_BIN" ] || [ ! -x "$UVICORN_BIN" ]; then
  echo "ERROR: Python .venv not found at .venv/. Create it or activate your Python environment."
  exit 1
fi

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

echo "Starting ML Service (:8000)..."
(cd "$ROOT_DIR/ml-service" && "$UVICORN_BIN" app:app --host 127.0.0.1 --port 8000) &
PIDS+=($!)

echo "Starting Backend (:4000)..."
(cd "$ROOT_DIR/backend" && npm run build >/dev/null && node dist/server.js) &
PIDS+=($!)

sleep 3

echo "Starting Simulator (1 Hz stream)..."
(cd "$ROOT_DIR" && PYTHONPATH="$ROOT_DIR" "$PY_BIN" -m simulator.cli --mode stream --endpoint "$BACKEND_INGEST_URL" --interval-sec 2.0) &
PIDS+=($!)

echo "Starting Frontend (:5173)..."
(cd "$ROOT_DIR/frontend" && VITE_API_URL="" VITE_WS_URL="" npm run dev -- --host 127.0.0.1 --port 5173) &
PIDS+=($!)

echo "GridSense running without Docker at http://localhost:5173 (Ctrl+C to stop)"
wait
