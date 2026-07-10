-- Simple internal agenda.
CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  note TEXT,
  ai_suggested boolean NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_account_starts
  ON calendar_events(account_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_assignee_starts
  ON calendar_events(assigned_to, starts_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_calendar_events_contact
  ON calendar_events(contact_id);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_events_select ON calendar_events;
DROP POLICY IF EXISTS calendar_events_insert ON calendar_events;
DROP POLICY IF EXISTS calendar_events_update ON calendar_events;
DROP POLICY IF EXISTS calendar_events_delete ON calendar_events;

CREATE POLICY calendar_events_select ON calendar_events FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY calendar_events_insert ON calendar_events FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY calendar_events_update ON calendar_events FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY calendar_events_delete ON calendar_events FOR DELETE
  USING (is_account_member(account_id, 'admin'));

ALTER TABLE calendar_events REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'calendar_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calendar_events;
  END IF;
END $$;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'calendar_event_due'));

CREATE OR REPLACE FUNCTION notify_due_calendar_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  INSERT INTO notifications (
    account_id, user_id, type, contact_id, conversation_id, title, body
  )
  SELECT
    e.account_id,
    COALESCE(e.assigned_to, e.user_id),
    'calendar_event_due',
    e.contact_id,
    e.conversation_id,
    CASE WHEN e.starts_at < NOW() THEN 'Agenda overdue' ELSE 'Agenda reminder' END,
    e.title || ' - ' || COALESCE(c.name, c.phone, 'contact')
  FROM calendar_events e
  JOIN contacts c ON c.id = e.contact_id
  WHERE e.status = 'pending'
    AND e.starts_at <= NOW() + INTERVAL '1 hour'
    AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.type = 'calendar_event_due'
        AND n.user_id = COALESCE(e.assigned_to, e.user_id)
        AND n.contact_id = e.contact_id
        AND n.created_at > NOW() - INTERVAL '12 hours'
        AND n.body = e.title || ' - ' || COALESCE(c.name, c.phone, 'contact')
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION notify_due_calendar_events() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION notify_due_calendar_events() TO authenticated;
