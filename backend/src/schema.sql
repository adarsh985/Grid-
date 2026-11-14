CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Time-series table. UNIQUE(meter_id, ts) makes duplicate delivery idempotent
-- and doubles as the (meter_id, timestamp) index requested for range queries.
CREATE TABLE IF NOT EXISTS readings (
  id BIGSERIAL PRIMARY KEY,
  meter_id TEXT NOT NULL REFERENCES meters(id),
  ts TIMESTAMPTZ NOT NULL,
  voltage_a DOUBLE PRECISION NOT NULL,
  voltage_b DOUBLE PRECISION NOT NULL,
  voltage_c DOUBLE PRECISION NOT NULL,
  current_a DOUBLE PRECISION NOT NULL,
  current_b DOUBLE PRECISION NOT NULL,
  current_c DOUBLE PRECISION NOT NULL,
  power_factor DOUBLE PRECISION NOT NULL,
  frequency DOUBLE PRECISION NOT NULL,
  active_energy_kwh DOUBLE PRECISION NOT NULL,
  fault_label TEXT,
  CONSTRAINT readings_meter_ts_unique UNIQUE (meter_id, ts)
);
CREATE INDEX IF NOT EXISTS readings_meter_ts_idx ON readings (meter_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  meter_id TEXT NOT NULL REFERENCES meters(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','closed')),
  assigned_to TEXT,
  detected_at TIMESTAMPTZ NOT NULL,
  last_detected_at TIMESTAMPTZ NOT NULL,
  loss_kw DOUBLE PRECISION NOT NULL DEFAULT 0,
  energy_loss_kwh DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_meter_type_idx ON alerts (meter_id, type, detected_at);

CREATE TABLE IF NOT EXISTS alert_events (
  id SERIAL PRIMARY KEY,
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
