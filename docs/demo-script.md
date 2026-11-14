# GridSense Live Demo Script

**Estimated duration:** 3–4 minutes  
**Preconditions:** Full stack running (`docker compose up -d --build`), seeded accounts ready, browser open at `http://localhost:5173`.

---

## Step 1 — Sign In (`/login`)
- **Action:** Click the **Operator** quick-fill button (`operator@gridsense.local` / `ChangeMe123!`) and submit **Sign In**.
- **Expected visible result:** Redirects to `/` (**Control Room**). The top header displays the **`[OPERATOR]`** role badge, **`OPEN ALERTS`**, **`LOSS TODAY (kWh)`**, and a pulsing cyan **`LIVE`** badge (indicating Socket.IO is connected and JWT is held in memory only).
- **What to say:** *"We sign in as an operator. The JWT is stored strictly in memory—never in `localStorage`—and the header switches to `LIVE` over Socket.IO."*

## Step 2 — Fleet Overview & Single-Line Schematic (`/`)
- **Action:** Point out the 3 substation feeders (`FDR-01`, `FDR-02`, `FDR-03`), the 20 smart-meter nodes, and the live **Alert Feed** on the right. Press `Ctrl+K` (or `Cmd+K`) to open the Command Palette, type `MTR-0109`, and press `Enter`.
- **Expected visible result:** Command Palette filters to `MTR-0109` and navigates to `/meters/MTR-0109` (or `/meters/MTR-009` in seeded DB).
- **What to say:** *"Every meter streams 3-phase voltage, current, power factor, and frequency. Operators can jump to any meter in two keystrokes with `Cmd/Ctrl+K`."*

## Step 3 — Meter Detail Oscilloscope (`/meters/MTR-0109`)
- **Action:** Inspect the 15-minute rolling 3-phase voltage and current charts and the phase imbalance indicator.
- **Expected visible result:** 3-phase waveforms (`Va/Vb/Vc`, `Ia/Ib/Ic`) render with live updates and any active fault highlighted.
- **What to say:** *"Here we see the 15-minute rolling 3-phase waveforms so an engineer can immediately distinguish a single-phase overload from a 3-phase voltage sag or meter bypass."*

## Step 4 — Inject Live Power-Theft Fault & Observe Ripple (`/`)
- **Action:** Return to `/` (**Control Room**). In the **Simulator Controls** bar, select target meter and click **Inject Theft** (or run `docker compose exec simulator python -m simulator.cli --mode inject-theft --target-meter MTR-001 --endpoint http://backend:4000/api/readings`).
- **Expected visible result:** Within 5 seconds, a cyan/red fault **ripple** animates on the schematic, the target meter node turns **Critical**, **OPEN ALERTS** increments by 1, and the new `Power Theft` alert appears at the top of the live **Alert Feed** and in `/alerts`.
- **What to say:** *"When we inject a 55% current bypass while voltage stays nominal at 230V, the simulator posts to the backend, the ML ensemble scores it against the meter's time-of-day load profile, and Socket.IO pushes the alert and ripple to the UI in under 5 seconds."*

## Step 5 — Triage, Explanation & Audit Log (`/alerts`)
- **Action:** Navigate to `/alerts` (or click the new alert). Expand/select the `Power Theft` row, read the top-3 plain-language explanations, press **`A`** (or click **Acknowledge**), and press **`Shift+A`** to assign.
- **Expected visible result:** Top-3 plain-language causes appear (e.g., load drop vs. time-of-day profile), status changes to `acknowledged`, **OPEN ALERTS** decrements by 1, and the **Audit Log** drawer records both `acknowledged` and `assigned` events with timestamps and actor email.
- **What to say:** *"Instead of a black-box anomaly score, operators get ranked plain-language explanations and an immutable PostgreSQL audit trail."*

## Step 6 — Analytics & Energy Loss Parity (`/analytics`)
- **Action:** Navigate to `/analytics`. Compare **Loss Today (kWh)** with the header **LOSS TODAY** counter, toggle `7D` / `30D`, and click a cell in the `7×24` fault heatmap.
- **Expected visible result:** **Loss Today** matches the header **LOSS TODAY** identically (`0.00` delta), `30D` expands the window, and clicking a heatmap cell filters the breakdown by day and hour.
- **What to say:** *"Analytics uses the exact same IST energy-loss formula as the backend `/api/reports/energy-loss` endpoint, so the control room header and analytics KPI always agree."*

## Step 7 — Model Health & Drift Monitoring (`/model-health`)
- **Action:** Navigate to `/model-health`. Review the held-out test metrics (`F1 0.8638`, `Precision 0.7624`, `Recall 0.9963`), per-fault breakdown, and the live **PSI Drift** meter.
- **Expected visible result:** Held-out evaluation metrics match `docs/model-evaluation.md` exactly, clearly separated from the live rolling PSI drift window (`0.20` warning threshold).
- **What to say:** *"We separate training-time held-out metrics from live PSI drift. If the ML service is stopped, this page displays `NOT EVALUATED` rather than inventing numbers."*
