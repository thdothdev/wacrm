-- Track why the AI paused a conversation and when a contact name came from the AI.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_reason text;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS name_source text;

CREATE INDEX IF NOT EXISTS idx_conversations_ai_handoff_reason
  ON conversations(ai_handoff_reason)
  WHERE ai_handoff_reason IS NOT NULL;
