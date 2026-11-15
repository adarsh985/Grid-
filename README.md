# GridSense

AI-assisted low-voltage Smart Grid distribution monitoring, anomaly detection, and operator triage telemetry platform. Developed for coursework.

> **Disclaimer**: All substation telemetry, historical analytics windows, and fault simulations in this repository are synthetic or seeded data generated for coursework demonstration. Live stream health is explicitly indicated by the **`LIVE`** / **`MOCK`** badge in the console header.

## Problem Statement

Distribution utilities monitor 3-phase low-voltage feeders for voltage sags, swells, phase imbalances, harmonic distortion, overcurrent spikes, and power theft. GridSense pairs a deterministic electrical grid physics simulator with a hybrid machine-learning scoring service (Isolation Forest + PyTorch LSTM Autoencoder + hard electrical rules) and an industrial HMI operator console to detect faults under 5 seconds, trace root-cause contributing features, and track operator acknowledgment audit logs.

## Architecture

```mermaid
flowchart LR
    SIM["Simulator (Python, 1 Hz telemetry)"] -->|POST /api/readings| BE["Backend API (Node / Express / Socket.IO)"]
    BE <-->|SQL: meters, readings, alerts, audit| PG[("PostgreSQL 16")]
    BE <-->|POST /predict, GET /model/info| ML["ML Service (FastAPI: IF + LSTM + Rules)"]
    FE["Frontend HMI (React + Vite Proxy :5173)"] <-->|/api & /socket.io| BE
    FE <-->|/model/info (via /model/ proxy)| ML
```

For full service boundaries, RBAC roles, and energy-loss parity details, see [docs/architecture.md](docs/architecture.md).

## Quick Setup (Docker Compose)

1. Ensure **Docker Desktop** (or Docker Engine + Compose v2) is running.
2. Build and start all five services (`postgres`, `ml-service`, `backend`, `frontend`, `simulator`):
   ```bash
   docker compose up -d --build
   ```
3. Verify services are healthy (`backend` automatically runs schema migration and idempotent demo seeding on startup):
   ```bash
   docker compose ps
   ```
4. Open the operator console at [http://localhost:5173](http://localhost:5173) and sign in with the seeded operator credentials:
   - **Email**: `operator@gridsense.local`
   - **Password**: `ChangeMe123!`
   *(Also seeded: `admin@gridsense.local` and `viewer@gridsense.local`, all with password `ChangeMe123!`.)*
5. To stop the stack cleanly:
   ```bash
   docker compose down
   ```

## Deploy Without Docker (Vercel + Render / Neon — Full Stack)

Because the backend uses persistent **Socket.IO WebSockets** and `ml-service` loads **PyTorch**, Vercel hosts the static React UI (`frontend/`) while cloud services host the API, ML scorer, Postgres, and simulator with **zero Docker storage used on your Mac**:

1. **Deploy Backend, ML Service, Simulator & Postgres (`render.yaml`)**:
   - Create a Blueprint on Render from this repo (uses `render.yaml`, installs CPU-only PyTorch so cloud builds stay lightweight).
   - Set `BACKEND_INGEST_URL` on `gridsense-simulator` to `https://<your-backend-service>.onrender.com/api/readings`.
2. **Deploy Frontend on Vercel (`frontend/`)**:
   - Import the repo in Vercel with **Root Directory** set to `frontend` (`frontend/vercel.json` configures SPA routing automatically).
   - Add Environment Variables in Vercel:
     - `VITE_API_URL=https://<your-backend-service>.onrender.com`
     - `VITE_WS_URL=https://<your-backend-service>.onrender.com`
     - `VITE_ML_SERVICE_URL=https://<your-ml-service>.onrender.com`
   - Redeploy Vercel (`CORS_ORIGIN` on backend & `ml-service` supports your Vercel URL or `*`).

## Run Locally Without Docker (Zero Docker Storage)

If you remove Docker images (`docker compose down -v --rmi all`) and want to run all 4 services directly with Node + `.venv` Python + any Postgres URI (for example a free Neon Postgres `DATABASE_URL` in `.env`):

```bash
./scripts/run-local-no-docker.sh
```

## Live Demo Flow

Follow [docs/demo-script.md](docs/demo-script.md) for the step-by-step live walkthrough:
1. Sign in at `/login` -> confirm the **`LIVE`** badge on the top status bar.
2. Click **`SIM: + INJECT THEFT`** on the Control Room (`/`), or inject via CLI (`python -m simulator.cli --mode inject-theft`), and observe the fault ripple and new alert within 5 seconds.
3. Open **Alerts (`/alerts`)** -> select the new alert (`J`/`K` + `Enter`) -> acknowledge with `A` -> verify the persistent audit log entry and synchronized Open Alerts count.
4. Inspect **Analytics (`/analytics`)** (IST `Asia/Kolkata` timezone + `LOSS TODAY` parity), **Meter Detail (`/meters/MTR-009`)**, and **Model Health (`/model-health`)**.

## Engineering Decisions & Important Notes

- **Vite Dev-Proxy Trailing Slash (`/model/` vs `/model`)**: In `frontend/vite.config.ts`, proxy rules forward `/api`, `/socket.io`, and `/model/` (with the trailing slash) to Compose DNS targets `BACKEND_PROXY_URL` (`http://backend:4000`) and `ML_PROXY_URL` (`http://ml-service:8000`). Using `/model/` instead of `/model` prevents Vite from intercepting the React SPA route `/model-health` as a backend API request.
- **Precision vs. Recall Tradeoff (`0.7624` vs `0.9963`)**: Evaluated on `11,500` chronological holdout readings (`docs/model-evaluation.md`), the hybrid ensemble achieves `Recall = 0.9963`, `Precision = 0.7624`, `F1 = 0.8638`, and `FPR = 0.0728`. We intentionally bias toward high recall so missed critical grid faults and theft intervals are near zero (`FN = 8`), accepting boundary false alarms from the unsupervised Isolation Forest + LSTM layers (`FP = 678`), which future threshold calibration or labeled supervised filtering can tighten.
- **In-Memory JWT Storage (Never `localStorage`)**: Authentication tokens and user claims live strictly in React/module memory inside `AuthContext` + `api.ts`. This avoids persistent token exposure in browser storage across sessions; reloading the browser returns the user to `/login` cleanly.
- **Explicit Offline Fallback (`MOCK` Badge)**: If backend services are stopped during frontend-only development, `/login` offers an explicit **Offline Mock Fallback (No Backend)** button that displays synthetic telemetry under a permanent **`MOCK`** indicator. `/model-health` never fakes ML evaluation numbers and renders **`NOT EVALUATED`** when `ml-service` is unreachable.

## Test Suites

Run the four component verification suites locally:

- **Frontend** (`frontend/`): `npm test && npm run build` (25 Vitest cases covering tokens, LiveValue, DeviationBars, CommandPalette, fault injection, alerts triage/undo, IST analytics parity, Model Health boundaries, and in-memory JWT routing)
- **Backend** (`backend/`): `npm test && npm run typecheck && npm run build` (20 Jest tests across health, RBAC auth, ingest, fault injection, alerts audit trail, and IST energy-loss parity)
- **ML Service** (`ml-service/`): `pytest` (4 FastAPI inference, rule layer, and `/model/info` drift tests)
- **Simulator** (`simulator/`): `pytest` (12 telemetry physics and fault injection tests)

## Known Limitations

- Refreshing the browser clears the in-memory JWT token and requires signing in again at `/login`.
- First-time Docker build for `ml-service` downloads PyTorch Python wheels.
- Multi-day 30-day historical curves are seeded at container initialization for coursework demo visualization; live real-time packets accumulate continuously from boot.
