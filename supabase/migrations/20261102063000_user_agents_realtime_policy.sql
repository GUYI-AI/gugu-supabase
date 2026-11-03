-- Hosts subscribe directly to their owner's agent changes, including without a renderer.
CREATE POLICY gugu_user_agents_select ON realtime.messages
FOR SELECT TO authenticated
USING (
  split_part(topic, ':', 1) = 'gugu'
  AND split_part(topic, ':', 2) = 'user'
  AND split_part(topic, ':', 3) = (SELECT auth.uid()::text)
  AND split_part(topic, ':', 4) = 'agents'
);
