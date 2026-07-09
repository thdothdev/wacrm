-- Add per-account uazapi server URL for manual instance-token setup.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS uazapi_base_url TEXT;
