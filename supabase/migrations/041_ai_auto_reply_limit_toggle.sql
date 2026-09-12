-- Preserve the existing reply cap by default while allowing it to be disabled.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_limit_enabled boolean NOT NULL DEFAULT true;
