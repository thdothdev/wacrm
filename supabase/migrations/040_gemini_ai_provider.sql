-- Allow Gemini in the existing AI configuration and usage tables.
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check,
  ADD CONSTRAINT ai_configs_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check,
  ADD CONSTRAINT ai_usage_log_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'gemini'));
