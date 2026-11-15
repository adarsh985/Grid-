# GridSense Architecture

GridSense is a five-service low-voltage Smart Grid telemetry, anomaly detection, and operator triage system designed around explicit service boundaries and strict separation between live backend state and offline fallback simulation.

## 1. Service Boundaries & Container Networking

Inside Docker Compose, services communicate exclusively over internal DNS service names:

| Service | Runtime | Port | Role |
| --- | --- | --- | --- |
| `postgres` | Postgres 16 Alpine | `5432` | Stores `users`, `meters`, `readings`, `alerts`, and `alert_events` audit logs. |
| `ml-service` | Python 3.11 + FastAPI | `8000` | Scores telemetry with Isolation Forest + PyTorch LSTM Autoencoder + Hard Rule Layer; exposes `/predict`, `/health`, and `/model/info`. |
| `backend` | Node 20 + Express + Socket.IO | `4000` | Validates & enforces RBAC JWT auth, stores telemetry, invokes `ml-service`, persists alerts/audit logs, and pushes Socket.IO events. |
| `simulator` | Python 3.11 | — | Generates 1 Hz physical 3-phase readings (`MTR-001`..`MTR-020`) and supports CLI fault injection. |
| `frontend` | React + TypeScript + Vite | `5173` | Industrial HMI SPA serving operators and proxying `/api`, `/socket.io`, and `/model/` over Compose DNS (`backend:4000`, `ml-service:8000`). |

### Why `/model/` Proxy Trailing Slash Matters

`frontend/vite.config.ts` routes:
- `/api` -> `BACKEND_PROXY_URL` (`http://backend:4000` in Compose)
- `/socket.io` -> `BACKEND_PROXY_URL` (`ws: true`)
- `/model/` -> `ML_PROXY_URL` (`http://ml-service:8000` in Compose)

Keeping the trailing slash on `/model/` ensures browser requests to the SPA route `/model-health` fall through to `index.html`, whereas `/model/info` proxies directly to FastAPI inside `ml-service`.

## 2. Live Telemetry & Fault Triage Flow

1. **Telemetry Generation (`1 Hz`)**: `simulator` posts batches or individual meter packets (`voltage_r/y/b`, `current_r/y/b`, `power_kw`, `power_factor`, `frequency_hz`, `thd_pct`) to `POST /api/readings`. Operators can also trigger UI simulator faults via `POST /api/simulator/inject-fault` (`operator` / `admin` role).
2. **Persistence & ML Scoring**: `backend/src/ingest.ts` stores the reading in Postgres `readings`, loads recent meter history, and calls `ml-service` (`POST /predict`) with fallback error logging if `ml-service` is down.
3. **Alert Creation & Audit Logging**: When `is_anomaly` is detected above threshold, `backend` creates a row in `alerts` (including `contributing_features` / `explanation`) and writes an initial entry to `alert_events`.
4. **Socket.IO Real-Time Push**: `backend` broadcasts `telemetry:reading`, `alert:new`, and `alert:update` over Socket.IO.
5. **Operator Triage**: In `/alerts`, acknowledging (`A`), assigning (`Shift+A`), or closing (`C`, with 2.5s undo window) transitions the alert in Postgres (`PATCH /api/alerts/:id`), inserts a corresponding row in `alert_events`, updates all connected consoles over Socket.IO, and keeps Control Room `OPEN ALERTS` and Alerts open counts synchronized (`GET /api/alerts` -> `open_count`).

## 3. Frontend HMI Architecture

- **Design Tokens (`frontend/src/design/tokens.ts`)**: Dark/Light control-room theme tokens with consistent 3-phase colors (Phase R Amber `#F59E0B`, Phase Y Cyan `#38BDF8`, Phase B Magenta `#E879F9`) and fault severity encoding.
- **Control Room (`/`)**:
  - `KpiStrip`: 40-sample SVG sparklines and `SIMULATOR CONTROLS (DEMO ONLY)` triggers.
  - `GridMap`: Custom interactive SVG feeder topology (`FDR-01`..`FDR-03`) with load-scaled power-flow particles, hover magnetism, and one-shot fault ripples.
  - `AlertFeed`: Live severity-prioritized feed linked to drawer/meter inspection.
- **Meter Detail (`/meters/:id`)**: Real-time uPlot/Canvas waveform `Oscilloscope`, vector `PhasorDiagram`, per-phase balance bars, and ML `DeviationBars`.
- **Alerts Triage (`/alerts`)**: Keyboard-first dense operator table (`J`/`K`, `Enter`, `A`, `Shift+A`, `C`), slide-over detail drawer, 10-reading history snapshot, `alert_events` audit timeline, and responsive mobile card layout.
- **Analytics (`/analytics`)**: Shared energy-loss formula (`backend/src/energyLoss.ts` & `frontend/src/analytics/aggregate.ts`) computing daily IST (`Asia/Kolkata`) kWh loss (`today_energy_loss_kwh`), 7×24 IST fault heatmap, and feeder comparisons.
- **Model Health (`/model-health`)**: Distinguishes held-out chronological evaluation metrics (`docs/model-evaluation.md`: Precision, Recall, F1, FPR, per-fault breakdown) from live sliding-window drift monitoring (`max_psi`). When `/model/info` fails, displays `NOT EVALUATED` instead of synthetic fallback metrics.

## 4. In-Memory JWT RBAC Security Model

- `POST /api/auth/login` issues an HMAC-signed JWT containing user ID, email, and role (`viewer`, `operator`, `admin`).
- **Storage Policy**: The frontend stores the JWT strictly in JavaScript memory (`AuthContext` + `api.ts`), **never** in `localStorage` or `sessionStorage`. Unauthenticated visits redirect to `/login`.
- **Role Enforcement**:
  - `viewer`: read-only endpoints (`/api/meters`, `/api/alerts`, `/api/reports/energy-loss`).
  - `operator`: viewer routes plus `PATCH /api/alerts/:id` and `POST /api/simulator/inject-fault`.
  - `admin`: operator routes plus `POST /api/auth/register`.
