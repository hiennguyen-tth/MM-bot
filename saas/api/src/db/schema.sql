-- MM Bot SaaS — PostgreSQL Schema
-- Run: psql -U mmbot -d mmbot -f schema.sql
-- Compatible with PostgreSQL 14+

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Exchange credentials (API keys stored encrypted) ─────────────────────────
-- api_key_enc / api_secret_enc: AES-256-GCM, format: base64(iv):base64(tag):base64(ct)
CREATE TABLE IF NOT EXISTS user_credentials (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange       TEXT        NOT NULL CHECK (exchange IN ('binance', 'bingx')),
    label          TEXT        NOT NULL DEFAULT 'default',
    api_key_enc    TEXT        NOT NULL,
    api_secret_enc TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, exchange, label)
);

-- ── Bot configurations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_configs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cred_id     UUID        NOT NULL REFERENCES user_credentials(id),
    symbol      TEXT        NOT NULL DEFAULT 'BTC/USDT:USDT',
    risk_level  TEXT        NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'custom')),
    capital     NUMERIC(18,2) NOT NULL,   -- USDT allocated
    config_json JSONB       NOT NULL,    -- generated env-var config
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Bot instances (lifecycle) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_instances (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config_id   UUID        NOT NULL REFERENCES bot_configs(id),
    status      TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','stopping','stopped','error','circuit_breaker')),
    stop_reason TEXT,
    job_id      TEXT,
    started_at  TIMESTAMPTZ,
    stopped_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_instances_user_status ON bot_instances(user_id, status);

-- ── Metrics time-series ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_metrics (
    id                 BIGSERIAL   PRIMARY KEY,
    instance_id        UUID        NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
    user_id            UUID        NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    realized_pnl       NUMERIC(20,8),
    hourly_pnl         NUMERIC(20,8),
    max_drawdown       NUMERIC(20,8),
    inventory          NUMERIC(20,8),
    fill_rate          NUMERIC(8,4),
    quotes_placed      INT,
    fills              INT,
    adverse_fill_ratio NUMERIC(8,4),
    regime             TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_instance_time ON bot_metrics(instance_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_user_time     ON bot_metrics(user_id, recorded_at DESC);

-- ── Auto-update updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER tg_users_upd     BEFORE UPDATE ON users             FOR EACH ROW EXECUTE FUNCTION _set_updated_at();
    CREATE TRIGGER tg_creds_upd     BEFORE UPDATE ON user_credentials  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();
    CREATE TRIGGER tg_configs_upd   BEFORE UPDATE ON bot_configs        FOR EACH ROW EXECUTE FUNCTION _set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Telegram chat_id (added after initial schema) ─────────────────────────────
-- Users register their Telegram chat_id via PUT /auth/telegram
-- Platform then sends bot start/stop/metrics notifications to their Telegram.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
