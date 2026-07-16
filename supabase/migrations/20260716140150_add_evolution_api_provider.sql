ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS evolution_base_url TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_webhook_secret TEXT;

UPDATE public.whatsapp_config
SET provider = CASE
  WHEN instance_token IS NOT NULL THEN 'uazapi'
  ELSE 'meta'
END
WHERE provider IS NULL;

ALTER TABLE public.whatsapp_config
  ALTER COLUMN provider SET DEFAULT 'meta',
  ALTER COLUMN provider SET NOT NULL;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;

ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi', 'evolution'));

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_evolution_instance_unique
  ON public.whatsapp_config (evolution_base_url, evolution_instance_name)
  WHERE provider = 'evolution';