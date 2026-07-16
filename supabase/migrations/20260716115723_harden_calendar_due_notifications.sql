-- Restrict the agenda reminder RPC to the caller's account membership.
-- It remains SECURITY DEFINER because notification rows are system-created.

CREATE OR REPLACE FUNCTION notify_due_calendar_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, contact_id, conversation_id, title, body
  )
  SELECT
    e.account_id,
    COALESCE(e.assigned_to, e.user_id),
    'calendar_event_due',
    e.contact_id,
    e.conversation_id,
    CASE WHEN e.starts_at < NOW() THEN 'Agenda vencida' ELSE 'Lembrete da agenda' END,
    e.title || ' - ' || COALESCE(c.name, c.phone, 'contato')
  FROM calendar_events e
  JOIN contacts c ON c.id = e.contact_id
  WHERE e.status = 'pending'
    AND is_account_member(e.account_id)
    AND e.starts_at <= NOW() + INTERVAL '1 hour'
    AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.type = 'calendar_event_due'
        AND n.user_id = COALESCE(e.assigned_to, e.user_id)
        AND n.contact_id = e.contact_id
        AND n.created_at > NOW() - INTERVAL '12 hours'
        AND n.body = e.title || ' - ' || COALESCE(c.name, c.phone, 'contato')
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION notify_due_calendar_events() OWNER TO postgres;
REVOKE ALL ON FUNCTION notify_due_calendar_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION notify_due_calendar_events() FROM anon;
GRANT EXECUTE ON FUNCTION notify_due_calendar_events() TO authenticated;
