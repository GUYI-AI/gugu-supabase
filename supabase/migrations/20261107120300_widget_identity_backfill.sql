-- Register the widget messages sent before chat.widgets existed; the insert
-- trigger has registered every one since. A release of its own: it only reads
-- chat.messages and writes chat.widgets, so sends are not held while it scans.
-- Historical identities are their message ids: no wid was system-issued before,
-- so an old body's wid is never trusted. Rows already registered are left as
-- they are, which makes the release safe to run again.
SET LOCAL statement_timeout = '10min';

INSERT INTO chat.widgets(id, chat_id, message_id, app, view, text, data, created_by, created_at)
SELECT m.id, m.chat_id, m.id, w.spec->>'app', w.spec->>'view', w.spec->>'text', w.spec->'data', m.sender_user_id, m.created_at
  FROM chat.messages m
  CROSS JOIN LATERAL (SELECT chat.widget_spec(m.content) AS spec) w
 WHERE m.content_type = 'widget' AND w.spec IS NOT NULL
ON CONFLICT DO NOTHING;
