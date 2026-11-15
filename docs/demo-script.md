# GridSense Live Demo Script

Run duration: ~3 minutes. Designed for live presentation on Docker Compose at `http://localhost:5173`.

## Pre-Flight

1. Start all services cleanly:
   ```bash
   docker compose up -d --build
   ```
2. Open `http://localhost:5173`. Unauthenticated requests redirect to `/login` (confirming JWTs are never stored in `localStorage`).
3. Sign in with `operator@gridsense.local` / `ChangeMe123!`.
4. Point out the green **`LIVE`** badge in the top header (`MOCK` never appears while connected to the backend Socket.IO stream).

---

## Walkthrough Steps

### 1. Control Room Overview (`/`)
- Point out the KPI strip (`GRID LOAD`, `FREQUENCY`, `MEAN PHASE VOLTAGE`, `PEAK NEMA IMBALANCE`, `FAULTED TERMINALS`) updating at `1 Hz` from the live Python simulator.
- Hover over feeders in the SVG schematic (`GridMap`) to show load-scaled power-flow particles along `FDR-01`, `FDR-02`, and `FDR-03`.
- **Action**: Click **`SIM: + INJECT THEFT`** inside **`SIMULATOR CONTROLS (DEMO ONLY)`**.
- **Verify visible outcome**: Within `< 5s`, the request posts through `backend` -> `ml-service` -> Postgres -> Socket.IO:
  - A fault ripple expands on the affected terminal in the schematic.
  - A new high/critical alert appears at the top of the Live Alert Feed and increments `CRIT/HIGH` + Header `OPEN ALERTS`.

### 2. Meter Inspection (`/meters/MTR-009` or `/meters/MTR-0109`)
- Click a feeder terminal or press `Ctrl+K` / `Cmd+K` to jump to Meter Detail (`MTR-009`).
- Point out:
  - Real-time 3-phase `Oscilloscope` waveforms (`R` Amber, `Y` Cyan, `B` Magenta).
  - Vector `PhasorDiagram` showing angular displacement & unbalance.
  - ML root-cause feature weights (`DeviationBars`) explaining *why* the anomaly triggered.

### 3. Operator Triage & Audit Trail (`/alerts`)
- Navigate to **Alerts (`/alerts`)** and highlight that the open alerts count matches Control Room and PostgreSQL (`open_count`).
- **Action (Keyboard-first)**:
  - Press `J` / `K` to select the newly generated `power_theft` alert.
  - Press `Enter` to open the slide-over inspection drawer (showing feature deviations and last 10 telemetry readings).
  - Press `A` to **Acknowledge** the alert.
- **Verify visible outcome**: Status transitions to `acknowledged`, `audit_log` / `Audit Timeline` records `acknowledged` with the operator email (`operator@gridsense.local`), and open alert count decrements everywhere simultaneously.

### 4. Energy Loss & IST Heatmap (`/analytics`)
- Navigate to **Analytics (`/analytics`)** (defaults to `Asia/Kolkata` IST shift window).
- Point out that **`LOSS TODAY`** matches backend `/api/reports/energy-loss` (`today_energy_loss_kwh`) using the shared `estimateEnergyLossKwh` formula shown in the footer, alongside the 7×24 IST fault heatmap.

### 5. ML Evaluation & Degraded Resilience (`/model-health`)
- Navigate to **Model Health (`/model-health`)**.
- Explain the clear separation between **Held-Out Test Split (`11,500` readings)** and **Live Window (`max_psi` drift)**:
  - **Headline numbers**: `Recall = 0.9963`, `Precision = 0.7624`, `F1 = 0.8638`, `FPR = 0.0728` (exact match with `docs/model-evaluation.md`).
  - **Why Recall is higher than Precision**: Missing a live power-theft or transformer fault is operationally costly, so thresholding catches `>99.6%` of fault intervals (`FN = 8`), accepting unsupervised boundary false alarms (`FP = 678`).
- *(Optional resilience check)*: Stop `ml-service` (`docker compose stop ml-service`) and reload `/model-health` to prove **`NOT EVALUATED`** renders cleanly with zero fabricated numbers, then restore with `docker compose start ml-service`.
