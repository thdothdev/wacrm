-- ============================================================
-- 036_whatsapp_config_uazapi.sql — Add uazapi support
--
-- Adds columns to support uazapi (non-official WhatsApp API) 
-- in addition to Meta's official API.
--
-- Meta mode stores:    phone_number_id + access_token + waba_id
-- uazapi mode stores:  instance_id + instance_token + connection_state
--
-- Both modes coexist — config can be Meta or uazapi at any time
-- (switching between them requires clearing the old config first).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Add uazapi-specific columns
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS instance_id TEXT,
  ADD COLUMN IF NOT EXISTS instance_token TEXT,
  ADD COLUMN IF NOT EXISTS connection_state TEXT CHECK (connection_state IN ('disconnected', 'connecting', 'connected', 'hibernated')),
  ADD COLUMN IF NOT EXISTS qr_code TEXT,
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscribed_apps_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_registration_error TEXT;

-- Create index on instance_id for lookups during webhook processing
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_instance_id ON whatsapp_config(instance_id);

-- Instance state transitions should default to 'disconnected' if not set
ALTER TABLE whatsapp_config
  ALTER COLUMN connection_state SET DEFAULT 'disconnected';
